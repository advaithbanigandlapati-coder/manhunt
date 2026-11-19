// Stand-in for the Cloudflare runtime so the real game server class runs in the browser.
export class DurableObject {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
