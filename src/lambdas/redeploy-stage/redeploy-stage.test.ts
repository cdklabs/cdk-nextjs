/* eslint-disable import/no-extraneous-dependencies */
// Only the client is mocked; the command classes stay real so assertions can
// read `command.input`. `send` goes through the holder because the module
// constructs its client at import time.
jest.mock("@aws-sdk/client-api-gateway", () => ({
  ...jest.requireActual("@aws-sdk/client-api-gateway"),
  APIGatewayClient: jest.fn(() => ({
    send: (...args: unknown[]) => holder.send(...args),
  })),
}));

import {
  CreateDeploymentCommand,
  DeleteDeploymentCommand,
  GetDeploymentsCommand,
  GetStagesCommand,
} from "@aws-sdk/client-api-gateway";
import { REDEPLOY_DESCRIPTION_PREFIX, redeployStage } from "./redeploy-stage";

const holder = { send: jest.fn() };

const input = {
  restApiId: "api1",
  stageName: "prod",
  stackStatus: "UPDATE_COMPLETE",
};

/** The API as it is: its deployments (pages of them) and its stages. */
function stubApi(
  pages: { id: string; description?: string }[][],
  stages: { stageName: string; deploymentId: string }[],
) {
  holder.send.mockImplementation((command: unknown) => {
    if (command instanceof CreateDeploymentCommand) {
      return Promise.resolve({ id: "new" });
    }
    if (command instanceof GetStagesCommand) {
      return Promise.resolve({ item: stages });
    }
    if (command instanceof GetDeploymentsCommand) {
      const index = Number(command.input.position ?? 0);
      return Promise.resolve({
        items: pages[index],
        position: index + 1 < pages.length ? String(index + 1) : undefined,
      });
    }
    return Promise.resolve({});
  });
}

function sent<T>(type: new (...args: never[]) => T): T[] {
  return holder.send.mock.calls
    .map(([command]) => command)
    .filter((command): command is T => command instanceof type);
}

beforeEach(() => holder.send.mockReset());

it("deploys the stage from the live API", async () => {
  stubApi([[]], [{ stageName: "prod", deploymentId: "new" }]);

  await expect(redeployStage(input)).resolves.toBe("new");

  expect(sent(CreateDeploymentCommand).map((c) => c.input)).toEqual([
    {
      restApiId: "api1",
      stageName: "prod",
      description: `${REDEPLOY_DESCRIPTION_PREFIX} UPDATE_COMPLETE`,
    },
  ]);
});

it("deletes only its own earlier deployments no stage references", async () => {
  const ours = (id: string) => ({
    id,
    description: `${REDEPLOY_DESCRIPTION_PREFIX} UPDATE_COMPLETE`,
  });
  stubApi(
    [
      // CloudFormation's own, its previous run's, and the new one.
      [
        {
          id: "cfn",
          description: "Automatically created by the RestApi construct",
        },
        ours("prev"),
      ],
      // A run whose deployment another stage still serves, on a second page.
      [ours("pinned"), ours("new")],
    ],
    [
      { stageName: "prod", deploymentId: "new" },
      { stageName: "canary", deploymentId: "pinned" },
    ],
  );

  await redeployStage(input);

  expect(sent(DeleteDeploymentCommand).map((c) => c.input)).toEqual([
    { restApiId: "api1", deploymentId: "prev" },
  ]);
});

it("does not fail the run when a prune is rejected", async () => {
  stubApi(
    [[{ id: "prev", description: `${REDEPLOY_DESCRIPTION_PREFIX} x` }]],
    [],
  );
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const send = holder.send.getMockImplementation()!;
  holder.send.mockImplementation((command: unknown) =>
    command instanceof DeleteDeploymentCommand
      ? Promise.reject(new Error("BadRequestException"))
      : send(command),
  );

  await expect(redeployStage(input)).resolves.toBe("new");
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});
