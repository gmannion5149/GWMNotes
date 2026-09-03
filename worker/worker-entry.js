/* ══════════════════════════════════════════════════════════════════════════════
   GWM CLIO API — entry point
   Front door for the Worker. Calendar automation gets first look at every
   request (it only claims /google/* and /gwm/*); everything else goes to the
   original worker.js untouched. The cron handler lives here too.
   ══════════════════════════════════════════════════════════════════════════════ */
import original, { clioFetch } from './worker.js';
import { gwmRoute, gwmScheduled } from './gwm-calendar-automation.js';

function hooksFor(env) {
  return { clioFetch: (path, init) => clioFetch(env, path, init) };
}

export default {
  async fetch(request, env, ctx) {
    const gwm = await gwmRoute(request, env, ctx, hooksFor(env));
    if (gwm) return gwm;
    return original.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(gwmScheduled(event, env, ctx, hooksFor(env)));
  }
};
