'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

/**
 * An action whose entire result is a redirect. Nothing to render, nothing to
 * return - which is exactly the shape that broke.
 *
 * A server action answers with an RSC response carrying `x-action-redirect`, and
 * the browser's router navigates on that header. With no body to write, the
 * response is a zero-payload stream, and a Lambda Function URL discards the
 * prelude of one of those: the header vanished, the client got a bare 200, and the
 * page simply stayed put. `padEmptyBody` in the runtime's sink exists for this,
 * and the symptom was silent - no error anywhere, just a form that did nothing.
 *
 * `revalidatePath` is scoped to this action's own target, so the e2e stays safe to
 * run alongside the rest of the suite.
 */
export async function redirectAction() {
  revalidatePath('/server-actions/redirect/done');
  redirect('/server-actions/redirect/done');
}
