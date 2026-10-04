import { describe, expect, it } from "vitest";

import { errorFromResponse, FenfillApi } from "../src/api.js";
import { apiConfigFromEnv, apiUrlFromEnv } from "../src/config.js";
import { ToolError } from "../src/errors.js";
import { API_KEY, API_URL, apiError, json, MockApi, virtualClock } from "./helpers.js";

function client(mock: MockApi, clock = virtualClock()) {
  return {
    clock,
    api: new FenfillApi({ apiKey: API_KEY, apiUrl: API_URL }, { fetchImpl: mock.fetch, ...clock }),
  };
}

async function thrown(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  throw new Error("expected a ToolError");
}

describe("config", () => {
  it("accepts https, and http only on loopback", () => {
    expect(apiUrlFromEnv({})).toBe("https://api.fenfill.com");
    expect(apiUrlFromEnv({ FENFILL_API_URL: "http://localhost:8000/" })).toBe(
      "http://localhost:8000",
    );
    expect(apiUrlFromEnv({ FENFILL_API_URL: "http://127.0.0.1:8000" })).toBe(
      "http://127.0.0.1:8000",
    );
    expect(() => apiUrlFromEnv({ FENFILL_API_URL: "http://api.fenfill.com" })).toThrow(/https/);
    expect(() => apiUrlFromEnv({ FENFILL_API_URL: "https://u:p@api.fenfill.com" })).toThrow();
  });

  it("requires a well-formed key only when asked for the API settings", () => {
    expect(() => apiConfigFromEnv({})).toThrow(/FENFILL_API_KEY/);
    expect(() => apiConfigFromEnv({ FENFILL_API_KEY: "sk-nope" })).toThrow(/API key/);
    expect(apiConfigFromEnv({ FENFILL_API_KEY: API_KEY }).apiKey).toBe(API_KEY);
  });
});

describe("error envelope mapping", () => {
  it("carries code, message, hint and the envelope extras", async () => {
    const e402 = await errorFromResponse(apiError(402, "insufficient_scans", { need: 7, have: 2 }));
    expect(e402.code).toBe("insufficient_scans");
    expect(e402.details).toMatchObject({ status: 402, need: 7, have: 2 });
    expect(e402.hint).toMatch(/needs 7 page scans and 2 are left/);

    const e429 = await errorFromResponse(
      apiError(429, "daily_limit", { retry_after: 3600 }, { "retry-after": "3600" }),
    );
    expect(e429.details.retry_after).toBe(3600);
    expect(e429.hint).toMatch(/daily/);

    const e413 = await errorFromResponse(apiError(413, "file_too_large", { max_bytes: 1024 }));
    expect(e413.details.max_bytes).toBe(1024);

    const split = await errorFromResponse(
      json(422, {
        error: {
          code: "too_many_pages",
          message: 'This PDF has 130 pages … (e.g. "1-60", then "61-120").',
        },
      }),
    );
    expect(split.message).toContain('"1-60"');
    expect(split.hint).toMatch(/chunks/);

    for (const code of [
      "invalid_api_key",
      "key_revoked",
      "plan_required",
      "template_frozen",
      "not_found",
      "template_limit",
      "template_not_restricted",
      "result_expired",
      "not_pdf",
      "pdf_password_required",
      "pdf_fill_forbidden",
      "rate_limited",
      "too_many_active_jobs",
      "queue_full",
      "internal_error",
      "unavailable",
    ]) {
      const e = await errorFromResponse(apiError(400, code));
      expect(e.code).toBe(code);
      expect(e.hint, code).toBeTruthy();
    }
  });

  it("words not_found, template_frozen and result_expired for what was asked", async () => {
    const job = await errorFromResponse(apiError(404, "not_found"), "job");
    expect(job.hint).toMatch(/analysis job/);
    expect(job.hint).not.toMatch(/template/);
    const tpl = await errorFromResponse(apiError(404, "not_found"), "template");
    expect(tpl.hint).toMatch(/list_templates/);
    const frozen = await errorFromResponse(apiError(403, "template_frozen"), "job");
    expect(frozen.hint).toMatch(/saved as a template.*list_templates/);
    const expired = await errorFromResponse(apiError(410, "result_expired"));
    expect(expired.hint).toMatch(/template was deleted/);

    // Through the client: the path decides.
    const mock = new MockApi()
      .on("GET", /^\/v1\/jobs\//, () => apiError(404, "not_found"))
      .on("GET", /^\/v1\/templates\//, () => apiError(404, "not_found"));
    const { api } = client(mock);
    expect((await thrown(api.getJson("/jobs/j1?include=render"))).hint).toMatch(/analysis job/);
    expect((await thrown(api.getJson("/templates/t1"))).hint).toMatch(/list_templates/);
  });

  it("tells chunking apart from a page past the plan's window (too_many_pages)", async () => {
    const tooMany = (message: string) =>
      errorFromResponse(json(422, { error: { code: "too_many_pages", message } }));
    const chunk = await tooMany(
      'This PDF has 130 pages and one job analyzes up to 60. Split it with pages (e.g. "1-60").',
    );
    expect(chunk.hint).toMatch(/chunks/);
    const past = await tooMany(
      "Your plan analyzes the first 10 pages of a document; page 11 is past that.",
    );
    expect(past.hint).toMatch(/won't reach/);
    expect(past.hint).toMatch(/upgrade/);
  });

  it("maps a non-envelope response by status", async () => {
    const e = await errorFromResponse(new Response("<html>bad gateway</html>", { status: 502 }));
    expect(e.code).toBe("internal_error");
    expect(e.details.enveloped).toBe(false);
  });
});

describe("request shape", () => {
  it("sends Bearer auth and the fenfill-mcp User-Agent", async () => {
    const mock = new MockApi().on("GET", /^\/v1\/account$/, () => json(200, { tier: "pro" }));
    await client(mock).api.getJson("/account");
    expect(mock.calls[0].headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(mock.calls[0].headers["user-agent"]).toMatch(/^fenfill-mcp\//);
    expect(mock.calls[0].url).toBe(`${API_URL}/v1/account`);
  });

  it("uploads only file, pages and save_as_template", async () => {
    const mock = new MockApi().on("POST", /^\/v1\/forms\/analyze$/, () =>
      json(202, { job_id: "j", status: "queued", mode: "ai", pages: [1], cost: 1 }),
    );
    await client(mock).api.analyze(new Uint8Array([37, 80, 68, 70]), "form.pdf", {
      pages: "1-2",
      saveAsTemplate: true,
    });
    const names = mock.calls[0].body.split("\n").map((l) => l.split("=")[0]);
    expect(names.sort()).toEqual(["file", "pages", "save_as_template"]);
    expect(mock.calls[0].body).toContain("file=form.pdf:%PDF");
  });
});

describe("retry policy", () => {
  it("retries a GET on rate_limited within the budget", async () => {
    let n = 0;
    const mock = new MockApi().on("GET", /^\/v1\/account$/, () =>
      ++n < 3
        ? apiError(429, "rate_limited", { retry_after: 2 }, { "retry-after": "2" })
        : json(200, { ok: true }),
    );
    const { api, clock } = client(mock);
    const t0 = clock.now();
    await expect(api.getJson("/account")).resolves.toMatchObject({ body: { ok: true } });
    expect(n).toBe(3);
    expect(clock.now() - t0).toBe(4000);
  });

  it("retries a GET on 503", async () => {
    let n = 0;
    const mock = new MockApi().on("GET", /^\/v1\/account$/, () =>
      ++n < 2 ? apiError(503, "unavailable") : json(200, { ok: true }),
    );
    await client(mock).api.getJson("/account");
    expect(n).toBe(2);
  });

  it("does not retry past the budget", async () => {
    const mock = new MockApi().on("GET", /^\/v1\/account$/, () =>
      apiError(429, "rate_limited", { retry_after: 60 }, { "retry-after": "60" }),
    );
    const { api, clock } = client(mock);
    const e = await thrown(api.getJson("/account", { deadline: clock.now() + 30_000 }));
    expect(e.code).toBe("rate_limited");
    expect(mock.calls).toHaveLength(1);
  });

  it.each(["daily_limit", "too_many_active_jobs", "queue_full"])(
    "never retries the 429 %s",
    async (code) => {
      const mock = new MockApi().on("GET", /^\/v1\/account$/, () =>
        apiError(429, code, { retry_after: 1 }, { "retry-after": "1" }),
      );
      expect((await thrown(client(mock).api.getJson("/account"))).code).toBe(code);
      expect(mock.calls).toHaveLength(1);
    },
  );

  it.each([
    [500, "internal_error"],
    [401, "invalid_api_key"],
    [404, "not_found"],
  ])("never retries HTTP %s", async (status, code) => {
    const mock = new MockApi().on("GET", /^\/v1\/account$/, () => apiError(status, code));
    await thrown(client(mock).api.getJson("/account"));
    expect(mock.calls).toHaveLength(1);
  });

  it("never re-sends the analyze POST on 503, daily_limit or a proxy's bare 429", async () => {
    for (const res of [
      () => apiError(503, "unavailable", {}, { "retry-after": "1" }),
      () => apiError(429, "daily_limit", { retry_after: 1 }, { "retry-after": "1" }),
      () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
    ]) {
      const mock = new MockApi().on("POST", /^\/v1\/forms\/analyze$/, res);
      await thrown(
        client(mock).api.analyze(new Uint8Array([1]), "f.pdf", { saveAsTemplate: false }),
      );
      expect(mock.calls).toHaveLength(1);
    }
  });

  it("never retries a JSON POST", async () => {
    const mock = new MockApi().on("POST", /recipients$/, () => apiError(503, "unavailable"));
    await thrown(client(mock).api.postJson("/templates/t/recipients", { label: "x" }));
    expect(mock.calls).toHaveLength(1);
  });
});

describe("analyze POST outcome", () => {
  it("a refused connection is a plain network error (nothing was sent)", async () => {
    const f = (() =>
      Promise.reject(
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      )) as typeof fetch;
    const api = new FenfillApi({ apiKey: API_KEY, apiUrl: API_URL }, { fetchImpl: f });
    const e = await thrown(api.analyze(new Uint8Array([1]), "f.pdf", { saveAsTemplate: false }));
    expect(e.code).toBe("network_error");
  });

  it("a connection cut mid-flight, or a bare 502, is an unknown outcome", async () => {
    const reset = (() =>
      Promise.reject(
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
      )) as typeof fetch;
    const api = new FenfillApi({ apiKey: API_KEY, apiUrl: API_URL }, { fetchImpl: reset });
    expect(
      (await thrown(api.analyze(new Uint8Array([1]), "f.pdf", { saveAsTemplate: false }))).code,
    ).toBe("upload_outcome_unknown");

    const mock = new MockApi().on(
      "POST",
      /^\/v1\/forms\/analyze$/,
      () => new Response("bad gateway", { status: 502 }),
    );
    expect(
      (
        await thrown(
          client(mock).api.analyze(new Uint8Array([1]), "f.pdf", { saveAsTemplate: false }),
        )
      ).code,
    ).toBe("upload_outcome_unknown");
  });
});

describe("analyze POST: waiting out a refusal before any job exists", () => {
  const accepted = () =>
    json(202, { job_id: "j", status: "queued", mode: "ai", pages: [1], cost: 1 });
  const api429 = (code: string, s: number) =>
    apiError(429, code, { retry_after: s }, { "retry-after": String(s) });
  function seeded(mock: MockApi, random = () => 0.5) {
    const clock = virtualClock();
    return {
      clock,
      api: new FenfillApi(
        { apiKey: API_KEY, apiUrl: API_URL },
        { fetchImpl: mock.fetch, ...clock, random },
      ),
    };
  }

  it.each(["rate_limited", "too_many_active_jobs", "queue_full"])(
    "re-POSTs after %s, honouring retry_after plus jitter",
    async (code) => {
      let n = 0;
      const mock = new MockApi().on("POST", /^\/v1\/forms\/analyze$/, () =>
        ++n < 3 ? api429(code, 5) : accepted(),
      );
      const { api, clock } = seeded(mock);
      const waits: number[] = [];
      const t0 = clock.now();
      const r = await api.analyze(
        new Uint8Array([1]),
        "f.pdf",
        { saveAsTemplate: false },
        {
          onWait: (s) => waits.push(s),
        },
      );
      expect(r.job_id).toBe("j");
      expect(n).toBe(3);
      expect(waits).toEqual([6, 6]); // 5 s + 0.5 × 2 s jitter
      expect(clock.now() - t0).toBe(12_000);
    },
  );

  it("gives up once the ~60 s budget is spent, saying how long it waited", async () => {
    const mock = new MockApi().on("POST", /^\/v1\/forms\/analyze$/, () =>
      api429("too_many_active_jobs", 25),
    );
    const { api } = seeded(mock, () => 0);
    const e = await thrown(api.analyze(new Uint8Array([1]), "f.pdf", { saveAsTemplate: false }));
    expect(mock.calls).toHaveLength(3); // waits 25 + 25; a third 25 would pass 60
    expect(e.code).toBe("too_many_active_jobs");
    expect(e.details).toMatchObject({ retry_after: 25, waited_s: 50 });
    expect(e.hint).toMatch(/Other analyses in this workspace.*already waited 50 s.*fewer/);
    expect(e.hint).not.toMatch(/call analyze_form again on it/);
  });

  it("does not wait a single retry_after longer than 30 s", async () => {
    const mock = new MockApi().on("POST", /^\/v1\/forms\/analyze$/, () =>
      api429("queue_full", 120),
    );
    const e = await thrown(
      seeded(mock).api.analyze(new Uint8Array([1]), "f.pdf", { saveAsTemplate: false }),
    );
    expect(mock.calls).toHaveLength(1);
    expect(e.code).toBe("queue_full");
    expect(e.details.waited_s).toBeUndefined();
  });

  it("a cancelled wait ends at once with the refusal, never re-POSTing", async () => {
    const mock = new MockApi().on("POST", /^\/v1\/forms\/analyze$/, () =>
      api429("rate_limited", 5),
    );
    const ac = new AbortController();
    const e = await thrown(
      seeded(mock).api.analyze(
        new Uint8Array([1]),
        "f.pdf",
        { saveAsTemplate: false },
        { signal: ac.signal, onWait: () => ac.abort() },
      ),
    );
    expect(mock.calls).toHaveLength(1);
    expect(e.code).toBe("rate_limited");
  });

  it("the too_many_active_jobs hint never tells the agent to resume jobs it may not own", async () => {
    const e = await errorFromResponse(api429("too_many_active_jobs", 30));
    expect(e.hint).toMatch(/Other analyses in this workspace/);
    expect(e.hint).toMatch(/native-field/);
    expect(e.hint).not.toMatch(/again on it/);
  });
});
