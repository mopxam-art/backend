import express, { Request, Response } from "express";
import request from "supertest";
import requestTimeout from "../middleware/requestTimeout";
import { EventEmitter } from "events";

describe("requestTimeout middleware timer cleanup and AbortSignal support", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("Dimension 1: Boundary & Clamping (Environment configuration & parsing)", () => {
    const invalidValues = [
      "",
      "   ",
      "0",
      "-1",
      "-5000",
      "abc",
      "invalid_number",
      "NaN",
      "undefined",
      "null",
      "Infinity",
      "-Infinity",
    ];

    it.each(invalidValues)(
      "falls back to default 30000ms when REQUEST_TIMEOUT_MS is invalid: '%s'",
      (val) => {
        jest.useFakeTimers();
        process.env.REQUEST_TIMEOUT_MS = val;

        const req: any = { path: "/api/test", headers: {}, destroy: jest.fn() };
        const res: any = new EventEmitter();
        res.headersSent = false;
        res.writableEnded = false;
        res.status = jest.fn().mockReturnThis();
        res.json = jest.fn();

        requestTimeout(req, res, () => {});

        // 29999ms: not aborted
        jest.advanceTimersByTime(29999);
        expect(req.signal.aborted).toBe(false);

        // 30001ms: aborted
        jest.advanceTimersByTime(2);
        expect(req.signal.aborted).toBe(true);

        jest.useRealTimers();
      },
    );

    it.each(invalidValues)(
      "falls back to default admin 60000ms when ADMIN_REQUEST_TIMEOUT_MS is invalid: '%s'",
      (val) => {
        jest.useFakeTimers();
        process.env.ADMIN_REQUEST_TIMEOUT_MS = val;

        const req: any = { path: "/admin/dashboard", headers: {}, destroy: jest.fn() };
        const res: any = new EventEmitter();
        res.headersSent = false;
        res.writableEnded = false;
        res.status = jest.fn().mockReturnThis();
        res.json = jest.fn();

        requestTimeout(req, res, () => {});

        // At 30s, admin request should still be alive
        jest.advanceTimersByTime(30000);
        expect(req.signal.aborted).toBe(false);

        // At 60001ms, admin request should time out
        jest.advanceTimersByTime(30001);
        expect(req.signal.aborted).toBe(true);

        jest.useRealTimers();
      },
    );

    const validCustomValues = [
      ["500", 500],
      ["1000", 1000],
      ["2500", 2500],
      ["15000", 15000],
      ["90000", 90000],
    ];

    it.each(validCustomValues)(
      "correctly honors valid custom REQUEST_TIMEOUT_MS '%s'",
      (valStr, expectedMs) => {
        jest.useFakeTimers();
        process.env.REQUEST_TIMEOUT_MS = valStr as string;

        const req: any = { path: "/custom", headers: {}, destroy: jest.fn() };
        const res: any = new EventEmitter();
        res.headersSent = false;
        res.writableEnded = false;
        res.status = jest.fn().mockReturnThis();
        res.json = jest.fn();

        requestTimeout(req, res, () => {});

        jest.advanceTimersByTime((expectedMs as number) - 1);
        expect(req.signal.aborted).toBe(false);

        jest.advanceTimersByTime(2);
        expect(req.signal.aborted).toBe(true);

        jest.useRealTimers();
      },
    );
  });

  describe("Dimension 2: Combinatorics (Route matching and timeout resolution)", () => {
    const routeTestCases = [
      { path: "/admin", isAdmin: true },
      { path: "/admin/", isAdmin: true },
      { path: "/admin/users", isAdmin: true },
      { path: "/admin/settings/security", isAdmin: true },
      { path: "/administrator", isAdmin: true },
      { path: "/admin-panel", isAdmin: true },
      { path: "/api/admin", isAdmin: false },
      { path: "/user/admin", isAdmin: false },
      { path: "/api/v1/projects", isAdmin: false },
      { path: "/health", isAdmin: false },
      { path: "/", isAdmin: false },
      { path: "", isAdmin: false },
      { path: undefined, isAdmin: false },
    ];

    it.each(routeTestCases)(
      "routes path '$path' to correct timeout category (isAdmin: $isAdmin)",
      ({ path, isAdmin }) => {
        jest.useFakeTimers();
        process.env.REQUEST_TIMEOUT_MS = "1000";
        process.env.ADMIN_REQUEST_TIMEOUT_MS = "2000";

        const req: any = { path, headers: {}, destroy: jest.fn() };
        const res: any = new EventEmitter();
        res.headersSent = false;
        res.writableEnded = false;
        res.status = jest.fn().mockReturnThis();
        res.json = jest.fn();

        requestTimeout(req, res, () => {});

        jest.advanceTimersByTime(1001);
        if (isAdmin) {
          expect(req.signal.aborted).toBe(false);
          jest.advanceTimersByTime(1000);
          expect(req.signal.aborted).toBe(true);
        } else {
          expect(req.signal.aborted).toBe(true);
        }

        jest.useRealTimers();
      },
    );
  });

  describe("Dimension 3: Host Variations & Signal Integration", () => {
    it("attaches both req.signal and req.abortSignal referencing the same AbortSignal", () => {
      const req: any = { path: "/check" };
      const res: any = new EventEmitter();
      let nextCalled = false;

      requestTimeout(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
      expect(req.signal).toBeDefined();
      expect(req.abortSignal).toBeDefined();
      expect(req.signal).toBe(req.abortSignal);
      expect(req.signal.aborted).toBe(false);
      res.emit("finish");
    });

    it("allows multiple downstream abort event listeners", () => {
      const req: any = { path: "/listener" };
      const res: any = new EventEmitter();
      res.writableEnded = false;

      requestTimeout(req, res, () => {});

      let listener1 = false;
      let listener2 = false;

      req.signal.addEventListener("abort", () => {
        listener1 = true;
      });
      req.signal.addEventListener("abort", () => {
        listener2 = true;
      });

      res.emit("close");

      expect(listener1).toBe(true);
      expect(listener2).toBe(true);
      expect(req.signal.aborted).toBe(true);
      expect((req.signal.reason as Error)?.message).toBe("Client disconnected");
    });

    it("handles pre-existing req.signal property descriptors gracefully", () => {
      const req: any = { path: "/desc" };
      Object.defineProperty(req, "signal", {
        value: undefined,
        writable: true,
        configurable: true,
      });
      const res: any = new EventEmitter();

      expect(() => {
        requestTimeout(req, res, () => {});
      }).not.toThrow();

      expect(req.signal).toBeInstanceOf(AbortSignal);
      res.emit("finish");
    });
  });

  describe("Dimension 4: Negative Controls & Protection against Double-Response", () => {
    it("does not attempt to send 408 if headers have already been sent", () => {
      jest.useFakeTimers();
      const req: any = { path: "/sent", destroy: jest.fn() };
      const res: any = new EventEmitter();
      res.headersSent = true;
      res.writableEnded = false;
      res.status = jest.fn().mockReturnThis();
      res.json = jest.fn();

      requestTimeout(req, res, () => {});

      jest.advanceTimersByTime(30001);

      expect(req.signal.aborted).toBe(true);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(req.destroy).toHaveBeenCalled();

      jest.useRealTimers();
    });

    it("does not abort signal if request finishes normally before timeout", () => {
      jest.useFakeTimers();
      const req: any = { path: "/normal", destroy: jest.fn() };
      const res: any = new EventEmitter();
      res.headersSent = true;
      res.writableEnded = true;

      requestTimeout(req, res, () => {});

      // Simulate normal completion
      res.emit("finish");

      // Advance timers way past timeout
      jest.advanceTimersByTime(60000);

      expect(req.signal.aborted).toBe(false);
      expect(req.destroy).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it("does not emit secondary abort if client disconnects after request ended normally", () => {
      const req: any = { path: "/ended", destroy: jest.fn() };
      const res: any = new EventEmitter();
      res.headersSent = true;
      res.writableEnded = true;

      requestTimeout(req, res, () => {});

      res.emit("finish");
      res.emit("close");

      expect(req.signal.aborted).toBe(false);
    });
  });

  describe("Dimension 5: Lifecycle, Stress & High-concurrency", () => {
    it.each(Array.from({ length: 60 }, (_, i) => i + 1))(
      "cleans up timers and memory reliably on rapid sequential execution #%d",
      async () => {
        const app = express();
        app.use(requestTimeout);
        app.get("/stress-ping", (req: Request, res: Response) => {
          expect(req.signal).toBeDefined();
          res.send("pong");
        });

        const res = await request(app).get("/stress-ping").expect(200);
        expect(res.text).toBe("pong");
      },
    );

    it("maintains strict signal isolation across 30 concurrent requests", async () => {
      const app = express();
      app.use(requestTimeout);

      const signals: AbortSignal[] = [];

      app.get("/isolated", (req: Request, res: Response) => {
        if (req.signal) signals.push(req.signal);
        res.json({ ok: true });
      });

      const promises = Array.from({ length: 30 }, () => request(app).get("/isolated"));
      const responses = await Promise.all(promises);

      expect(responses).toHaveLength(30);
      expect(signals).toHaveLength(30);

      const uniqueSignals = new Set(signals);
      expect(uniqueSignals.size).toBe(30);
    });

    it("clears timer on finish event without lingering timer references", () => {
      const originalClearTimeout = global.clearTimeout;
      let clearCalls = 0;
      global.clearTimeout = jest.fn((id: any) => {
        clearCalls++;
        originalClearTimeout(id);
      }) as any;

      const req: any = { path: "/clean" };
      const res: any = new EventEmitter();
      res.writableEnded = true;

      requestTimeout(req, res, () => {});
      res.emit("finish");

      expect(clearCalls).toBe(1);

      global.clearTimeout = originalClearTimeout;
    });
  });
});
