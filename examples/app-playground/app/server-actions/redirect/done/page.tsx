import { Boundary } from '#/ui/boundary';

export default function Page() {
  return (
    <Boundary labels={['redirect action done']} color="blue">
      <p data-testid="redirect-done" className="text-sm">
        redirect:done
      </p>
    </Boundary>
  );
}
