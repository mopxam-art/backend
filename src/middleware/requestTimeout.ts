import { Request, Response, NextFunction } from "express";
import { errorBody } from "./errors";

declare global {
  namespace Express {
    interface Request {
      signal?: AbortSignal;
      abortSignal?: AbortSignal;
    }
  }
}

const defaultTimeout = parseInt(process.env.REQUEST_TIMEOUT_MS || "30000", 10);
const adminTimeout = parseInt(process.env.ADMIN_REQUEST_TIMEOUT_MS || "60000", 10);

function parseTimeout(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default function requestTimeout(req: Request, res: Response, next: NextFunction): void {
  const configuredDefault = parseTimeout(process.env.REQUEST_TIMEOUT_MS, defaultTimeout);
  const configuredAdmin = parseTimeout(process.env.ADMIN_REQUEST_TIMEOUT_MS, adminTimeout);
  const timeoutMs = req.path && req.path.startsWith("/admin") ? configuredAdmin : configuredDefault;

  const controller = new AbortController();
  Object.defineProperty(req, "signal", {
    value: controller.signal,
    configurable: true,
    writable: true,
  });
  req.abortSignal = controller.signal;

  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Request timed out"));
    if (!res.headersSent) {
      res.status(408).json(errorBody("request_timeout", "Request timed out"));
    }
    req.destroy();
  }, timeoutMs);

  const cleanup = () => {
    clearTimeout(timer);
    if (!res.writableEnded && !timedOut) {
      controller.abort(new Error("Client disconnected"));
    }
  };

  res.once("finish", cleanup);
  res.once("close", cleanup);

  next();
}
