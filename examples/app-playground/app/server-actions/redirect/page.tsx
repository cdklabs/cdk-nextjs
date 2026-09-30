import Button from '#/ui/button';
import { Boundary } from '#/ui/boundary';
import { redirectAction } from './actions';

export default function Page() {
  return (
    <Boundary labels={['redirect action']} color="default">
      {/* A plain `action={}` form rather than `useActionState`: this has to be
          the case where the action returns nothing at all, so there is no state
          to thread and no body on the response. */}
      <form action={redirectAction}>
        <Button type="submit">Redirect via action</Button>
      </form>
    </Boundary>
  );
}
