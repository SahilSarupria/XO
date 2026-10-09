import type { ApiResponse, Middleware, RouteHandler } from './types.js';

interface CompiledRoute {
  readonly method: string;
  readonly segments: readonly RouteSegment[];
  readonly handler: RouteHandler;
}

type RouteSegment = { readonly kind: 'literal'; readonly value: string } | { readonly kind: 'param'; readonly name: string };

function compileSegments(path: string): readonly RouteSegment[] {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment): RouteSegment => (segment.startsWith(':') ? { kind: 'param', name: segment.slice(1) } : { kind: 'literal', value: segment }));
}

/**
 * A deliberately minimal method+path router — no regex DSL, no
 * wildcard/optional-segment support, because nothing this API exposes
 * needs it (every route in `routes/` is a fixed shape with at most one
 * or two `:param` segments). See README.md's "Framework choice" section
 * for why this exists instead of a dependency: there is nothing to
 * `npm install` in this sandbox (no network access, no vendored
 * `node_modules`), so the "minimal framework" the brief asks for is
 * this file, built on `node:http` directly.
 */
export class Router {
  private readonly routes: CompiledRoute[] = [];
  private readonly middlewares: Middleware[] = [];

  /** Registered in order; every request passes through every middleware before its matched handler — see `auth.ts` for the one currently registered. */
  use(middleware: Middleware): void {
    this.middlewares.push(middleware);
  }

  add(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), segments: compileSegments(path), handler });
  }

  get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.add('POST', path, handler);
  }

  /**
   * Finds the route matching `method`/`path`, wraps its handler with
   * every registered middleware (outermost-first), and returns that
   * composed handler — or `undefined` if nothing matches, in which case
   * the caller (`server.ts`) is responsible for a 404/405.
   *
   * `pathMatchedByOtherMethod` lets the caller distinguish "no such
   * route at all" (404) from "this path exists, wrong method" (405) —
   * `server.ts` uses it to pick between them.
   */
  resolve(method: string, path: string): { handler: RouteHandler; params: Readonly<Record<string, string>> } | undefined {
    const requestSegments = path.split('/').filter((segment) => segment.length > 0);
    const upperMethod = method.toUpperCase();

    for (const route of this.routes) {
      if (route.method !== upperMethod) continue;
      const params = matchSegments(route.segments, requestSegments);
      if (params === undefined) continue;
      return { handler: this.composeMiddleware(route.handler), params };
    }
    return undefined;
  }

  /** True if some route matches `path` for any method other than `method` — used to distinguish 404 from 405. */
  hasPathForOtherMethod(method: string, path: string): boolean {
    const requestSegments = path.split('/').filter((segment) => segment.length > 0);
    const upperMethod = method.toUpperCase();
    return this.routes.some((route) => route.method !== upperMethod && matchSegments(route.segments, requestSegments) !== undefined);
  }

  private composeMiddleware(handler: RouteHandler): RouteHandler {
    return (req) => {
      const chain = this.middlewares.reduceRight<() => Promise<ApiResponse>>((next, middleware) => () => middleware(req, next), () => handler(req));
      return chain();
    };
  }
}

function matchSegments(routeSegments: readonly RouteSegment[], requestSegments: readonly string[]): Readonly<Record<string, string>> | undefined {
  if (routeSegments.length !== requestSegments.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < routeSegments.length; i++) {
    const routeSegment = routeSegments[i];
    const requestSegment = requestSegments[i];
    if (routeSegment === undefined || requestSegment === undefined) return undefined;
    if (routeSegment.kind === 'literal') {
      if (routeSegment.value !== requestSegment) return undefined;
    } else {
      params[routeSegment.name] = decodeURIComponent(requestSegment);
    }
  }
  return params;
}
