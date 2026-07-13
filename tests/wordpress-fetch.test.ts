import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchClassTaxonomy, fetchRoster } from "../lib/wordpress";

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRoster — pagination (§1: do not stop at page 1)", () => {
  it("follows X-WP-TotalPages to the end and concatenates every page", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse([{ id: 1 }, { id: 2 }], { "X-WP-TotalPages": "2", "X-WP-Total": "126" })
      )
      .mockResolvedValueOnce(jsonResponse([{ id: 3 }], { "X-WP-TotalPages": "2", "X-WP-Total": "126" }));

    const result = await fetchRoster("https://healthprofessions.ucf.edu/wp-json/wp/v2/person");

    expect(result.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops after a single page when X-WP-TotalPages is 1", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([{ id: 1 }], { "X-WP-TotalPages": "1" }));

    const result = await fetchRoster("https://healthprofessions.ucf.edu/wp-json/wp/v2/person");

    expect(result).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("requests trimmed _fields and per_page=100", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([], { "X-WP-TotalPages": "1" }));

    await fetchRoster("https://healthprofessions.ucf.edu/wp-json/wp/v2/person");

    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain("per_page=100");
    expect(calledUrl).toContain("_fields=");
    expect(calledUrl).toContain("acf");
    expect(calledUrl).toContain("departments");
    expect(calledUrl).toContain("class");
  });

  it("throws on a non-ok response rather than silently truncating the roster", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("nope", { status: 500 }));

    await expect(
      fetchRoster("https://healthprofessions.ucf.edu/wp-json/wp/v2/person")
    ).rejects.toThrow();
  });
});

describe("fetchClassTaxonomy", () => {
  it("builds a term-ID -> name map from the class taxonomy endpoint", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse([
        { id: 10, name: "Faculty", slug: "class-faculty" },
        { id: 20, name: "Leadership", slug: "class-leadership" },
        { id: 467, name: "Staff", slug: "class-staff" },
      ])
    );

    const result = await fetchClassTaxonomy("https://healthprofessions.ucf.edu/wp-json/wp/v2/person");

    expect(result).toEqual({ 10: "Faculty", 20: "Leadership", 467: "Staff" });
    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(calledUrl).toBe(
      "https://healthprofessions.ucf.edu/wp-json/wp/v2/class?per_page=100&_fields=id,name,slug"
    );
  });

  it("throws on a non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("nope", { status: 500 }));

    await expect(
      fetchClassTaxonomy("https://healthprofessions.ucf.edu/wp-json/wp/v2/person")
    ).rejects.toThrow();
  });
});
