import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Real-time port of the categorizer in scripts/anonymize-data.py and
// scripts/import-public-pc.py. All three read config/categories.json and must
// agree: rules are checked in order, the first rule with any matching field
// wins. Fields are case-insensitive regexes against:
//   app    – process / app name
//   domain – URL hostname
//   title  – window or page title
//   url    – full URL (lets rules match paths such as youtube.com/shorts/).
//            The Python scripts ignore it, since their data has no full URLs.

export type ClassifyInput = {
  app?: string | null;
  title?: string | null;
  url?: string | null;
};

export type Classification = {
  category: string;
  subcategory?: string;
};

const FIELDS = ["app", "domain", "title", "url"] as const;
type Field = (typeof FIELDS)[number];

type RawRule = { category: string; subcategory?: string } & Partial<Record<Field, string>>;
type Rule = { category: string; subcategory?: string; patterns: Partial<Record<Field, RegExp>> };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.resolve(__dirname, "../../config/categories.json");

let cache: { rules: Rule[]; fallback: string } | null = null;

function load(): { rules: Rule[]; fallback: string } {
  if (cache) return cache;
  const raw = JSON.parse(fs.readFileSync(RULES_PATH, "utf8")) as {
    rules: RawRule[];
    fallback?: string;
  };
  const rules = raw.rules.map((r): Rule => {
    const patterns: Partial<Record<Field, RegExp>> = {};
    for (const f of FIELDS) {
      const src = r[f];
      if (src) patterns[f] = new RegExp(src, "i");
    }
    return { category: r.category, ...(r.subcategory ? { subcategory: r.subcategory } : {}), patterns };
  });
  cache = { rules, fallback: raw.fallback ?? "other" };
  return cache;
}

/** Hostname of a URL, or the input itself when it is already a bare domain. */
export function domainOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return url.includes("/") ? "" : url;
  }
}

export function classify(input: ClassifyInput): Classification {
  const { rules, fallback } = load();
  const values: Record<Field, string> = {
    app: input.app ?? "",
    domain: domainOf(input.url),
    title: input.title ?? "",
    url: input.url ?? "",
  };
  for (const rule of rules) {
    for (const f of FIELDS) {
      const re = rule.patterns[f];
      if (re && values[f] && re.test(values[f])) {
        return { category: rule.category, ...(rule.subcategory ? { subcategory: rule.subcategory } : {}) };
      }
    }
  }
  return { category: fallback };
}
