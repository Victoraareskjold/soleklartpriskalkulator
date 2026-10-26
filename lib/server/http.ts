import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { CalculationError } from "@/lib/engine";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "ERROR",
  ) {
    super(message);
  }
}

const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-File-Name",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { ...corsHeaders(req), "Cache-Control": "no-store" },
  });
}

export function preflight(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

type RouteContext<P> = { params: Promise<P> };

/** Pakker en route handler: CORS på alle svar og like feilmeldinger. */
export function handler<P = Record<string, never>>(fn: (req: Request, params: P) => Promise<unknown>) {
  return async (req: Request, ctx: RouteContext<P>) => {
    try {
      return json(req, await fn(req, await ctx.params));
    } catch (error) {
      if (error instanceof HttpError) {
        return json(req, { error: error.code, message: error.message }, error.status);
      }
      if (error instanceof CalculationError) {
        return json(req, { error: "INVALID_CALCULATION", field: error.field, message: error.message }, 422);
      }
      if (error instanceof z.ZodError) {
        const issue = error.issues[0];
        return json(req, { error: "BAD_REQUEST", field: issue?.path.join("."), message: issue?.message ?? "Ugyldig forespørsel" }, 400);
      }
      if (error instanceof SyntaxError) {
        return json(req, { error: "INVALID_JSON", message: "Ugyldig JSON" }, 400);
      }
      const pgCode = (error as { code?: string }).code;
      if (pgCode === "23505") return json(req, { error: "CONFLICT", message: "Finnes allerede" }, 409);
      if (pgCode === "23503") return json(req, { error: "BAD_REFERENCE", message: "Ugyldig referanse" }, 400);
      if (pgCode === "23514") return json(req, { error: "BAD_REQUEST", message: "Verdien er utenfor tillatt område" }, 400);
      console.error(error);
      return json(req, { error: "INTERNAL_ERROR", message: "Noe gikk galt" }, 500);
    }
  };
}

/** Leser og validerer JSON-body. */
export async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  return schema.parse(await req.json());
}
