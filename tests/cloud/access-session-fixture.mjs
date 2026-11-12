export { TargetMailbox, OwnerCatalog, NodeMailbox } from '../../cloud/worker.mjs';
import { accessSession } from '../../cloud/access.mjs';
// Exercise the production verifier in workerd without unrelated controller state.
export default { async fetch(request, env) {
  try {
    const session = await accessSession(request, env);
    return Response.json({ kind: session.automation ? 'automation' : 'owner' });
  } catch { return new Response(null, { status: 403 }); }
} };