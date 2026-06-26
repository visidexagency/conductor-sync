import { describe, expect, it } from "vitest";
import { classifyConductorError } from "../src/classify";

function sdkError(body: Record<string, unknown>, status?: number) {
  return Object.assign(new Error(String(body.message ?? "err")), {
    status: status ?? body.httpStatusCode,
    error: { error: body },
  });
}

describe("classifyConductorError", () => {
  it("treats SDK connection/timeout errors as transient", () => {
    expect(
      classifyConductorError(Object.assign(new Error("t"), { name: "APIConnectionTimeoutError" }))
    ).toBe("transient");
    expect(
      classifyConductorError(Object.assign(new Error("c"), { name: "APIConnectionError" }))
    ).toBe("transient");
  });

  it("treats stale revision (3200) as transient", () => {
    expect(classifyConductorError(sdkError({ integrationCode: "3200" }, 502))).toBe("transient");
  });

  it("treats 5xx and 429 as transient", () => {
    expect(classifyConductorError(sdkError({}, 503))).toBe("transient");
    expect(classifyConductorError(sdkError({}, 429))).toBe("transient");
  });

  it("treats auth errors as transient (rotated key is operator-fixable)", () => {
    expect(classifyConductorError(sdkError({}, 401))).toBe("transient");
    expect(classifyConductorError(sdkError({}, 403))).toBe("transient");
  });

  it("treats a downed QBD connection reported as 4xx as transient", () => {
    expect(
      classifyConductorError(sdkError({ code: "QBD_CONNECTION_ERROR", message: "connection not active" }, 400))
    ).toBe("transient");
  });

  it("treats other 4xx as permanent", () => {
    expect(classifyConductorError(sdkError({ code: "INVALID_REQUEST_ERROR", message: "bad field" }, 400))).toBe(
      "permanent"
    );
    expect(classifyConductorError(sdkError({}, 404))).toBe("permanent");
  });

  it("defaults unknown shapes to transient", () => {
    expect(classifyConductorError(new Error("who knows"))).toBe("transient");
  });
});
