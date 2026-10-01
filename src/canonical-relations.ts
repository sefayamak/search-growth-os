/**
 * URL Inspection canonical iliskileri — dil bagimsiz, deterministik, SAF.
 *
 * Girdi yalnizca UCU URL: denetlenen URL, Google'in sectigi canonical (googleCanonical) ve
 * sayfanin bildirdigi canonical (userCanonical). Hicbir metin alani (coverageState vb.)
 * girdi DEGILDIR: o metin tr-TR yerellestirilmis geliyor ("Yonlendirmeli sayfa") ve bir
 * string eslestirmesi dil degisince ya da Google metni degistirince sessizce yanlis sonuc
 * verir. Karar yalnizca URL alanlarina dayanir.
 *
 * Bu modul bir SEO HATASI iddia etmez. Iliskiler Google'in kendi yanitindaki alanlarin
 * karsilastirmasidir (FACT). `review_status: REVIEW_REQUIRED` "insan bakmali" demektir
 * (CANDIDATE); iki alan farkli diye site suclanmaz.
 *
 * Esitlik: normalizeUrl (parse + fragment atma). Sondaki "/", scheme, host, path, query
 * KORUNUR; hicbir sey tahminle birlestirilmez. "Ayni host" tam hostname esitligidir:
 * www.x.com ile x.com FARKLI hostname'dir (cross_domain = true).
 */
import { normalizeUrl } from "./url-inventory.ts";

export type Rel = "SAME" | "DIFFERENT" | "UNKNOWN";
export type Tri = boolean | "UNKNOWN";

export type ReviewReason =
  | "GOOGLE_CANONICAL_DIFFERS_FROM_INSPECTED"
  | "USER_CANONICAL_DIFFERS_FROM_GOOGLE"
  | "USER_CANONICAL_CROSS_DOMAIN"
  | "GOOGLE_CANONICAL_CROSS_DOMAIN";

/**
 * TURETILMIS desen. Yalniz iki iliskiden (`inspected_vs_google`, `user_vs_google`) cikar;
 * hostname/cross-domain alanlari kararin yerine GECMEZ (onlar ek FACT'tir).
 *  - DECLARED_GOOGLE_CONFLICT: sayfanin bildirdigi canonical ile Google'inki uyusmuyor.
 *  - GOOGLE_USER_CONVERGE_ON_OTHER_URL: denetlenen URL baska bir varyant, ama Google ve sayfa AYNI hedefte
 *    uzlasiyor. Bu bir canonical CATISMASI degildir; dogru HTTP redirect/canonical uygulamasi oldugu
 *    iddiasi da DEGILDIR (sayfa fetch edilmedi).
 *  - INSPECTED_USER_GOOGLE_ALIGNED: denetlenen == Google == bildirilen (ucu ayni URL). Siki: bildirilen canonical
 *    eksikse INCOMPLETE olur. (`review_status = NO_DIVERGENCE_OBSERVED` farkli ve daha genis bir alandir; ad bilerek ayri.)
 *  - INCOMPLETE: gerekli alan UNKNOWN, guvenilir desen cikarilamiyor.
 */
export type CanonicalPattern =
  | "DECLARED_GOOGLE_CONFLICT"
  | "GOOGLE_USER_CONVERGE_ON_OTHER_URL"
  | "INSPECTED_USER_GOOGLE_ALIGNED"
  | "INCOMPLETE";

export interface CanonicalRelations {
  inspected_vs_google: Rel;
  user_vs_google: Rel;
  user_vs_inspected: Rel;
  user_cross_domain: Tri;
  google_cross_domain: Tri;
  /** true yalniz bir tetikleyici GOZLENDIYSE. UNKNOWN alan tetikleyici sayilmaz ama "sorun yok" da demez. */
  review_required: boolean;
  /** REVIEW_REQUIRED = tetikleyici gozlendi (CANDIDATE, insan bakar). NO_DIVERGENCE_OBSERVED = eldeki alanlarda
   *  tetikleyici yok. UNKNOWN = temel iliski (denetlenen vs Google canonical) olculemedi ve baska tetikleyici de yok. */
  review_status: "REVIEW_REQUIRED" | "NO_DIVERGENCE_OBSERVED" | "UNKNOWN";
  reasons: ReviewReason[];
  /** Yeni, daha hassas turetilmis siniflandirma. `review_required` anlami DEGISMEDI. */
  canonical_pattern: CanonicalPattern;
}

/** Yalniz iki iliskiye bakar; hostname/cross-domain karari etkilemez. Celiski onceliklidir. */
export function derivePattern(inspected_vs_google: Rel, user_vs_google: Rel): CanonicalPattern {
  if (user_vs_google === "DIFFERENT") return "DECLARED_GOOGLE_CONFLICT";
  if (inspected_vs_google === "DIFFERENT" && user_vs_google === "SAME") return "GOOGLE_USER_CONVERGE_ON_OTHER_URL";
  if (inspected_vs_google === "SAME" && user_vs_google === "SAME") return "INSPECTED_USER_GOOGLE_ALIGNED";
  return "INCOMPLETE";
}

const parse = (v: unknown): URL | null => {
  if (typeof v !== "string" || !v || v === "UNKNOWN") return null;
  const n = normalizeUrl(v);
  return n ? new URL(n) : null;
};

const rel = (a: URL | null, b: URL | null): Rel => (!a || !b ? "UNKNOWN" : a.toString() === b.toString() ? "SAME" : "DIFFERENT");
const cross = (a: URL | null, b: URL | null): Tri => (!a || !b ? "UNKNOWN" : a.hostname !== b.hostname);

/** Sadece uc URL; coverageState gibi metin alanlari BILEREK parametre degildir. */
export function classifyCanonicalRelations(inspectedUrl: string, googleCanonical: unknown, userCanonical: unknown): CanonicalRelations {
  const ins = parse(inspectedUrl);
  const g = parse(googleCanonical);
  const u = parse(userCanonical);

  const inspected_vs_google = rel(ins, g);
  const user_vs_google = rel(u, g);
  const user_vs_inspected = rel(u, ins);
  const user_cross_domain = cross(u, ins);
  const google_cross_domain = cross(g, ins);

  const reasons: ReviewReason[] = [];
  if (inspected_vs_google === "DIFFERENT") reasons.push("GOOGLE_CANONICAL_DIFFERS_FROM_INSPECTED");
  if (user_vs_google === "DIFFERENT") reasons.push("USER_CANONICAL_DIFFERS_FROM_GOOGLE");
  if (user_cross_domain === true) reasons.push("USER_CANONICAL_CROSS_DOMAIN");
  if (google_cross_domain === true) reasons.push("GOOGLE_CANONICAL_CROSS_DOMAIN");

  const review_required = reasons.length > 0;
  const review_status = review_required ? "REVIEW_REQUIRED" : inspected_vs_google === "UNKNOWN" ? "UNKNOWN" : "NO_DIVERGENCE_OBSERVED";
  const canonical_pattern = derivePattern(inspected_vs_google, user_vs_google);
  return { inspected_vs_google, user_vs_google, user_vs_inspected, user_cross_domain, google_cross_domain, review_required, review_status, reasons, canonical_pattern };
}
