/**
 * Adaptateur Mailgun (compte US). Envoi multipart, auth Basic 'api:<KEY>', timeout dur.
 *
 * Deux pièges de conformité gérés ici :
 *  - le tracking open/clic est ON PAR DÉFAUT sur les domaines Mailgun → on force TOUJOURS les 3
 *    flags o:tracking/-opens/-clicks explicitement (défaut off) pour ne jamais poser de pixel
 *    sans consentement (C2) ;
 *  - Message-Id déterministe (<outbox_id@domaine>) → stable entre retries, les MUA collapsent
 *    un éventuel doublon (modèle at-least-once assumé).
 */
import type { WorkerConfig } from "./env";
import type { OutboxContext } from "./db";

export type SendResult = { ok: true; id: string } | { ok: false; retryable: boolean; error: string };

export interface SendMessage {
  domain: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  messageId: string;
  messageIdHost: string; // host STABLE (indépendant du domaine d'envoi) → Message-Id constant entre retries
  track: boolean;
  listUnsub?: string; // valeur du header List-Unsubscribe (welcome/broadcast)
  oneClick?: boolean; // émettre List-Unsubscribe-Post=One-Click
  replyTo?: string; // adresse de réponse réglée par édition (0078) — jamais le From
  vars?: Record<string, string>;
}

/**
 * Le NOM affiché dans le From, nettoyé pour un en-tête.
 *
 * ⛔ CE NOM EST ÉCRIT PAR UN HUMAIN DEPUIS L'ADMIN (nom de marque, nom d'expéditeur de l'édition) ET IL
 * ATTERRIT ENTRE GUILLEMETS DANS UN EN-TÊTE. Un `"` ferme la chaîne et fait lire la suite comme une
 * adresse ; un retour à la ligne ouvre un en-tête de plus. La route d'écriture refuse déjà ces
 * caractères et la base les interdit (0078) : ce nettoyage est la troisième barrière, parce que
 * `asset.name` existait bien avant ces deux-là et n'est passé par aucune.
 */
export function nomAffiche(brut: string | null | undefined): string {
  return (brut ?? "")
    .replace(/[\u0000-\u001f\u007f"\\<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
    .trim();
}

const EMAIL = /^[^\s@",;<>()\\]+@[^\s@",;<>()\\]+\.[a-z]{2,}$/i;

/** Adresse de réponse utilisable, ou rien. Une valeur mal formée est IGNORÉE, jamais envoyée. */
export function adresseDeReponse(brut: string | null | undefined): string | undefined {
  const v = (brut ?? "").trim();
  return v.length > 0 && v.length <= 254 && EMAIL.test(v) ? v : undefined;
}

// 4xx à rejet DUR (le message ne passera jamais tel quel) → permanent. Tout le reste (401/403 auth,
// 404 domaine non vérifié, 408/409/429, 5xx, réseau) est TRANSITOIRE/réparable par l'opérateur →
// retry avec backoff (borné par max_attempts). Évite qu'une clé/région erronée brûle toute la file.
const PERMANENT_4XX = new Set([400, 406, 413, 422]);

/**
 * Résout (domaine, From, Reply-To) selon le mode d'envoi. sandbox = shipper SAFE maintenant.
 *
 * Le NOM affiché et l'adresse de RÉPONSE sont réglables par édition (décision d'Alix, 22/09/2026).
 *
 * ⛔ L'ADRESSE D'ENVOI, ELLE, NE L'EST PAS — ET RIEN DE CE QUI EST SAISI NE PEUT LA TOUCHER. Le
 * domaine est TOUJOURS le sous-domaine d'envoi vérifié de l'édition (ou le bac à sable), la partie
 * locale TOUJOURS celle de la configuration du worker. Un From sur un autre domaine casse
 * l'alignement DMARC : les e-mails de la marque partent en spam, ou sont rejetés, pour toute la
 * liste. C'est pour cela que la réponse passe par un en-tête `Reply-To` séparé : on peut répondre à
 * `redaction@marque.com` sans jamais ENVOYER depuis cette adresse.
 */
export function resolveSender(
  cfg: WorkerConfig,
  ctx: OutboxContext,
): { domain: string; from: string; replyTo?: string } | null {
  // Le nom réglé de l'édition, puis le nom de la marque, puis un mot neutre — jamais un vide.
  const name = nomAffiche(ctx.from_name) || nomAffiche(ctx.asset_name) || "Newsletter";
  const replyTo = adresseDeReponse(ctx.reply_to);
  const avecReponse = replyTo ? { replyTo } : {};
  if (cfg.sendingMode === "sandbox") {
    if (!cfg.mailgun.sandboxDomain) return null;
    const domain = cfg.mailgun.sandboxDomain;
    return { domain, from: `"${name}" <postmaster@${domain}>`, ...avecReponse };
  }
  // mode asset (prod, DNS/DKIM faits)
  const domain = ctx.sending_subdomain;
  if (!domain) return null;
  return { domain, from: `"${name}" <${cfg.mailgun.fromLocalpart}@${domain}>`, ...avecReponse };
}

export class Mailgun {
  private base: string;
  private authHeader: string;
  private timeoutMs: number;

  constructor(cfg: WorkerConfig) {
    this.base = cfg.mailgun.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
    this.authHeader = "Basic " + Buffer.from(`api:${cfg.mailgun.apiKey ?? ""}`).toString("base64");
    this.timeoutMs = cfg.mailgun.timeoutMs;
  }

  async send(msg: SendMessage): Promise<SendResult> {
    const form = new FormData();
    form.append("from", msg.from);
    form.append("to", msg.to);
    form.append("subject", msg.subject);
    form.append("html", msg.html);
    form.append("text", msg.text);

    // Flags de suivi TOUJOURS explicites (défaut off) — jamais laissés au défaut du domaine.
    const flag = msg.track ? "yes" : "no";
    form.append("o:tracking", flag);
    form.append("o:tracking-opens", flag);
    form.append("o:tracking-clicks", flag);

    form.append("h:Message-Id", `<${msg.messageId}@${msg.messageIdHost}>`);
    if (msg.replyTo) form.append("h:Reply-To", msg.replyTo);
    /*
     * ⛔ LES EN-TÊTES `List-Unsubscribe` NE SONT PAS RÉGLABLES, ET C'EST VOULU. Gmail et Yahoo les
     * exigent des expéditeurs en volume (février 2024) : sans eux, les e-mails d'une marque perdent
     * leur place en boîte de réception. Ils sont calculés ici, jamais lus d'un réglage.
     */
    if (msg.listUnsub) {
      form.append("h:List-Unsubscribe", msg.listUnsub);
      if (msg.oneClick) form.append("h:List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
    }
    for (const [k, v] of Object.entries(msg.vars ?? {})) form.append(`v:${k}`, v);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}/v3/${msg.domain}/messages`, {
        method: "POST",
        headers: { Authorization: this.authHeader },
        body: form,
        signal: ctrl.signal,
      });
      const bodyText = await res.text();
      if (res.ok) {
        let id = "";
        try {
          id = (JSON.parse(bodyText) as { id?: string }).id ?? "";
        } catch {
          /* réponse non-JSON mais 2xx : on considère envoyé, id vide */
        }
        return { ok: true, id: id || msg.messageId };
      }
      // Permanent uniquement pour les rejets durs (message malformé) ; le reste = transitoire → retry.
      const retryable = !PERMANENT_4XX.has(res.status);
      return { ok: false, retryable, error: `mailgun ${res.status}: ${bodyText.slice(0, 300)}` };
    } catch (err) {
      // Timeout / réseau → temporaire.
      return { ok: false, retryable: true, error: `network: ${(err as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}
