"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Check, Copy, Loader2, Plus, ShieldCheck, TriangleAlert, Trash2, X } from "lucide-react";
import { PageHead, Btn, Pill, Th, Td, type Tone } from "@/components/ui";

/**
 * Comptes et accès — écran réel, branché sur `newsletter.app_user`.
 *
 * Il a longtemps affiché quatre personnes codées en dur et trois actions « Coming soon ». Ce
 * n'était pas seulement une maquette : il affirmait un modèle de droits (« Full access », « Send
 * only », « Read only ») que rien n'implémentait. Les rôles réels sont deux, et ce qui décide
 * vraiment de ce qu'on voit, ce sont les octrois de MARQUES et de TEMPLATES — d'où la place
 * qu'ils prennent ici.
 *
 * ⚠️ Le lien d'invitation n'est montré qu'une fois, à sa création : la base n'en garde que
 * l'empreinte. C'est pour ça qu'il s'affiche en grand, avec un bouton de copie, et pas dans un
 * coin de la ligne du tableau.
 */

export type UserRow = {
  id: string;
  email: string;
  role: "super_admin" | "member";
  status: "invited" | "active" | "disabled";
  /** « All brands » (0075) : toutes les marques, présentes et futures. Les octrois de marque
   *  ci-dessous restent stockés mais ignorés tant qu'il est vrai. */
  allAssets: boolean;
  /** « All templates » (0075) : tous les templates DES MARQUES QUE CE COMPTE VOIT, présents et
   *  futurs. ⛔ Indépendant du précédent — il n'ouvre aucune marque. */
  allTemplates: boolean;
  lastLoginAt: string | null;
  inviteExpiresAt: string | null;
  createdAt: string;
  assetIds: string[];
  templateIds: string[];
};

export type BrandRow = { id: string; name: string };
export type TemplateRow = { id: string; name: string; assetId: string };

const STATUT: Record<UserRow["status"], { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "green" },
  invited: { label: "Invited", tone: "amber" },
  disabled: { label: "Disabled", tone: "grey" },
};

/** ISO → `2026-08-31`, calculé en UTC : identique au rendu serveur et au rendu navigateur. */
const jour = (iso: string | null): string => {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "—";
};

const initiales = (email: string) =>
  email
    .split("@")[0]
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("") || "?";

/** Case à cocher étiquetée — la même dans les deux panneaux. */
function Case({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-[12.5px] ${
        disabled ? "opacity-45" : "cursor-pointer hover:bg-accent"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-[14px] w-[14px] accent-brand"
      />
      <span className="min-w-0 truncate">{children}</span>
    </label>
  );
}

/**
 * Une case « All » — celle des marques, celle des templates : la même forme, deux décisions.
 *
 * ⭐ DEUX CASES ET PLUS UNE (0075). Demande d'Alix : « faut que brands et template soient séparés ;
 * par exemple je veux qu'un user ait accès qu'à un domaine mais à tous les templates
 * automatiquement ». Une case unique ne pouvait pas écrire ce cas.
 *
 * ⚠️ Cochée, elle ne VIDE rien : la sélection explicite reste en mémoire (et en base) et revient
 * quand on la décoche. C'est pour ça que les cases en dessous sont montrées cochées et
 * DÉSACTIVÉES, pas décochées ni modifiées.
 */
function CaseTout({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="mb-1.5 rounded-[10px] border border-border p-1.5">
      <Case checked={checked} onChange={onChange}>
        <span className="font-medium">{label}</span>
      </Case>
      <p className="px-2 pb-1 text-[11.5px] text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * Mot de passe proposé par « Generate » : 20 caractères tirés par `crypto.getRandomValues`, sans les
 * signes qu'on confond en le recopiant (0/O, 1/l/I), en quatre blocs lisibles à voix haute.
 * ⚠️ Tiré dans le NAVIGATEUR et jamais envoyé ailleurs qu'à la route qui le hache : le serveur n'en
 * voit que la valeur choisie, comme pour un mot de passe tapé.
 */
const ALPHABET_MDP = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
function genererMotDePasse(): string {
  const tirage = crypto.getRandomValues(new Uint32Array(20));
  const s = Array.from(tirage, (n) => ALPHABET_MDP[n % ALPHABET_MDP.length]).join("");
  return s.match(/.{5}/g)!.join("-");
}
const MDP_MIN = 12;

const AIDE_MARQUES = "Includes brands added later.";
const AIDE_TEMPLATES = "Includes templates added later, in the brands this account can see.";

/**
 * Fenêtre modale.
 *
 * ⛔ ELLE DOIT PASSER PAR UN PORTAL, et ce n'est pas un raffinement : `position: fixed` se cale
 * sur le premier ancêtre qui porte un `transform`, pas sur le viewport. Or toutes les pages de
 * l'admin sont enveloppées dans `.animate-fade-up`, dont le keyframe se termine sur
 * `transform: translateY(0)` AVEC `animation-fill-mode: both` — le transform reste donc appliqué
 * une fois l'animation finie. Sans portal, `fixed inset-0` s'ajustait sur le bloc « Users &
 * access » : la modale s'ouvrait à l'intérieur du tableau, écrasée et illisible.
 *
 * `mounted` évite le décalage d'hydratation : `document` n'existe pas au rendu serveur.
 * Même pattern que le panneau mobile de la barre latérale.
 */
function Panneau({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Échap ferme, et le fond de page ne défile plus sous la modale.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Un clic DANS la fenêtre ne doit pas la fermer — seul le fond ferme. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] rounded-[14px] border border-border bg-card shadow-[0_12px_40px_rgba(20,20,30,0.18)]"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function Erreur({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-destructive/25 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
      <TriangleAlert className="mt-[1px] h-4 w-4 shrink-0" strokeWidth={2} />
      <span>{children}</span>
    </div>
  );
}

/** Le lien ne repassera plus : il s'affiche jusqu'à ce qu'on ferme le panneau, avec sa copie. */
function LienInvitation({ url }: { url: string }) {
  const [copie, setCopie] = useState(false);
  return (
    <div className="rounded-[10px] border border-border bg-accent/40 p-3">
      <div className="mb-1.5 text-[12px] font-semibold">Invitation link — shown once</div>
      <p className="mb-2.5 text-[12px] text-muted-foreground">
        Send it to the person yourself. It is not stored and no email is sent from here.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-[8px] border border-border bg-background px-2.5 py-2 text-[11.5px]">
          {url}
        </code>
        <Btn
          onClick={() => {
            navigator.clipboard.writeText(url).then(
              () => setCopie(true),
              () => setCopie(false),
            );
          }}
        >
          {copie ? <Check className="h-[15px] w-[15px]" /> : <Copy className="h-[15px] w-[15px]" />}
          {copie ? "Copied" : "Copy"}
        </Btn>
      </div>
    </div>
  );
}

export function UsersClient({
  selfId,
  users,
  brands,
  templates,
  indisponible,
}: {
  selfId: string;
  users: UserRow[];
  brands: BrandRow[];
  templates: TemplateRow[];
  indisponible?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // ---- invitation
  const [inviteOuvert, setInviteOuvert] = useState(false);
  const [email, setEmail] = useState("");
  const [roleInvite, setRoleInvite] = useState<"member" | "super_admin">("member");
  const [marquesInvite, setMarquesInvite] = useState<string[]>([]);
  const [toutesMarquesInvite, setToutesMarquesInvite] = useState(false);
  const [tousTemplatesInvite, setTousTemplatesInvite] = useState(false);
  const [lien, setLien] = useState("");

  // ---- édition
  const [editId, setEditId] = useState<string | null>(null);
  const cible = users.find((u) => u.id === editId) ?? null;
  const [role, setRole] = useState<"member" | "super_admin">("member");
  const [statut, setStatut] = useState<"active" | "disabled">("active");
  const [marques, setMarques] = useState<string[]>([]);
  const [tpl, setTpl] = useState<string[]>([]);
  // « All brands » et « All templates », INDÉPENDANTS (0075). `marques` et `tpl` restent la
  // sélection EXPLICITE, intacte pendant qu'une case « All » est cochée : c'est elle qui revient
  // quand on la décoche.
  const [toutesMarques, setToutesMarques] = useState(false);
  const [tousTemplates, setTousTemplates] = useState(false);
  // ---- mot de passe (bloc « Password » du panneau d'édition, indépendant de « Save »)
  const [mdp, setMdp] = useState("");
  const [mdpCopie, setMdpCopie] = useState(false);
  const [mdpFait, setMdpFait] = useState("");

  const nomMarque = useMemo(() => new Map(brands.map((b) => [b.id, b.name])), [brands]);
  const parMarque = useMemo(() => {
    const m = new Map<string, TemplateRow[]>();
    for (const t of templates) {
      const l = m.get(t.assetId);
      if (l) l.push(t);
      else m.set(t.assetId, [t]);
    }
    return m;
  }, [templates]);

  const bascule = (liste: string[], id: string, on: boolean) =>
    on ? [...new Set([...liste, id])] : liste.filter((x) => x !== id);

  function ouvrirEdition(u: UserRow) {
    setErr("");
    setEditId(u.id);
    setRole(u.role);
    // Un compte `invited` n'a pas de statut modifiable ici : le champ n'est pas proposé, mais il
    // faut bien une valeur de départ cohérente si l'invitation est acceptée entre-temps.
    setStatut(u.status === "disabled" ? "disabled" : "active");
    setMarques(u.assetIds);
    setTpl(u.templateIds);
    setToutesMarques(u.allAssets);
    setTousTemplates(u.allTemplates);
    setMdp("");
    setMdpCopie(false);
    setMdpFait("");
  }

  function fermer() {
    setEditId(null);
    setMdp("");
    setMdpCopie(false);
    setMdpFait("");
    setInviteOuvert(false);
    setLien("");
    setEmail("");
    setMarquesInvite([]);
    setToutesMarquesInvite(false);
    setTousTemplatesInvite(false);
    setRoleInvite("member");
    setErr("");
  }

  async function appeler(url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setErr(typeof d.error === "string" ? d.error : `Request failed (${res.status}).`);
        return null;
      }
      return d;
    } catch {
      setErr("Network error.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function inviter() {
    const d = await appeler("/api/users", {
      method: "POST",
      body: JSON.stringify({
        email,
        role: roleInvite,
        assetIds: marquesInvite,
        // Un administrateur voit déjà tout : les cases ne sont pas proposées, on n'envoie pas leur
        // reliquat. Les deux partent séparément — c'est le point de 0075.
        allAssets: roleInvite === "member" && toutesMarquesInvite,
        allTemplates: roleInvite === "member" && tousTemplatesInvite,
      }),
    });
    if (!d) return;
    // On garde le panneau ouvert : refermer ferait disparaître le lien, qui ne repassera pas.
    setLien(typeof d.inviteUrl === "string" ? d.inviteUrl : "");
    router.refresh();
  }

  async function enregistrer() {
    if (!cible) return;
    // ⛔ UN MOT DE PASSE SAISI PART AVEC « SAVE ». Le 02/10/2026, Alix a tapé celui d'une collègue
    // puis cliqué « Save » : seul « Set password » l'appliquait, la sauvegarde l'a ignoré EN SILENCE,
    // le panneau s'est fermé comme sur un succès, et la collègue est restée dehors. Cliquer « Save »
    // avec un mot de passe dans le champ veut dire « enregistre ce que je vois ».
    if (mdp && !mdpFait) {
      if (mdp.length < MDP_MIN) {
        setErr(`The new password needs at least ${MDP_MIN} characters — or clear the field.`);
        return;
      }
      if (!(await definirMotDePasse())) return;
    }
    // Les deux drapeaux partent toujours, même pour un administrateur : ils sont conservés tels
    // quels, et une rétrogradation plus tard retrouve l'état d'avant.
    const corps: Record<string, unknown> = {
      role,
      allAssets: toutesMarques,
      allTemplates: tousTemplates,
      assetIds: marques,
      templateIds: tpl,
    };
    if (cible.status !== "invited") corps.status = statut;
    const d = await appeler(`/api/users/${cible.id}`, { method: "PATCH", body: JSON.stringify(corps) });
    if (!d) return;
    router.refresh();
    fermer();
  }

  /** Agit TOUT DE SUITE, sans attendre « Save » : c'est un geste à part, avec sa propre route. Le
   *  panneau reste ouvert pour qu'on puisse encore copier le mot de passe. « Save » l'appelle aussi
   *  quand le champ est rempli. Rend `true` si le mot de passe est posé. */
  async function definirMotDePasse(): Promise<boolean> {
    if (!cible) return false;
    const d = await appeler(`/api/users/${cible.id}/password`, {
      method: "POST",
      body: JSON.stringify({ password: mdp }),
    });
    if (!d) return false;
    setMdpFait(
      d.activated === true
        ? "Password set. The account is active and the invitation link no longer works."
        : d.status === "disabled"
          ? "Password set. The account stays disabled until you set its status to Active."
          : "Password set. This person is signed out everywhere and must use the new password.",
    );
    // Un compte invité vient de passer actif : le bloc Status doit partir de « Active ».
    setStatut(d.status === "disabled" ? "disabled" : "active");
    router.refresh();
    return true;
  }

  async function supprimer(u: UserRow) {
    if (!window.confirm(`Remove ${u.email}? Their brand and template grants are removed too.`)) return;
    const d = await appeler(`/api/users/${u.id}`, { method: "DELETE" });
    if (!d) return;
    router.refresh();
    fermer();
  }

  // ⛔ La section Templates suit les MARQUES, jamais la case « All templates ». Marques cochées à la
  // main + « All templates » doit montrer les templates de CES marques-là — c'est exactement le cas
  // demandé par Alix, et le montrer faux ici ferait croire à un accès qu'on n'a pas donné.
  const marquesDeLaCible = role === "super_admin" || toutesMarques ? brands.map((b) => b.id) : marques;

  return (
    <div className="animate-fade-up">
      <PageHead
        title="Users & access"
        desc="Who can sign in, which brands they see, and which templates they can open and edit."
      >
        <Btn variant="dark" disabled={!!indisponible} onClick={() => setInviteOuvert(true)}>
          <Plus className="h-[15px] w-[15px]" strokeWidth={2} /> Invite user
        </Btn>
      </PageHead>

      {indisponible && (
        <div className="mb-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          {indisponible}
        </div>
      )}

      {err && !inviteOuvert && !editId && <Erreur>{err}</Erreur>}

      <div className="overflow-x-auto rounded-[14px] border border-border bg-card">
        <table className="w-full min-w-[760px] border-collapse text-[13px]">
          <thead>
            <tr className="bg-[#fcfcfe]">
              <Th>User</Th>
              <Th>Role</Th>
              <Th>Status</Th>
              <Th>Brands</Th>
              <Th>Templates</Th>
              <Th>Last sign-in (UTC)</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const s = STATUT[u.status];
              const soi = u.id === selfId;
              return (
                <tr key={u.id} className="transition-colors hover:bg-brand-soft/40">
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-foreground/70">
                        {initiales(u.email)}
                      </span>
                      <div className="min-w-0">
                        <b className="font-semibold">
                          {u.email}
                          {soi && (
                            <span className="ml-1.5 text-[11px] font-medium text-muted-foreground">(you)</span>
                          )}
                        </b>
                        <div className="text-[12px] text-muted-foreground">Added {jour(u.createdAt)}</div>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <Pill tone={u.role === "super_admin" ? "pink" : "blue"} dot>
                      {u.role === "super_admin" ? "Administrator" : "Member"}
                    </Pill>
                  </Td>
                  <Td>
                    <Pill tone={s.tone} dot>
                      {s.label}
                    </Pill>
                    {u.status === "invited" && (
                      <div className="mt-1 text-[11.5px] text-muted-foreground">
                        Link expires {jour(u.inviteExpiresAt)}
                      </div>
                    )}
                  </Td>
                  {/* ⛔ Chaque colonne lit SON drapeau : « All » en Brands sans « All » en
                      Templates est un état légitime, et l'inverse aussi. */}
                  <Td className="tabular-nums text-muted-foreground">
                    {u.role === "super_admin" || u.allAssets ? "All" : u.assetIds.length}
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">
                    {u.role === "super_admin" || u.allTemplates ? "All" : u.templateIds.length}
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">{jour(u.lastLoginAt)}</Td>
                  <Td>
                    <div className="flex justify-end gap-1.5">
                      <Btn
                        onClick={() => ouvrirEdition(u)}
                        disabled={soi || !!indisponible}
                        title={soi ? "You cannot change your own role or access." : undefined}
                        className="py-1.5"
                      >
                        Manage access
                      </Btn>
                      <Btn
                        variant="ghost"
                        aria-label={`Remove ${u.email}`}
                        onClick={() => supprimer(u)}
                        disabled={soi || busy || !!indisponible}
                        title={soi ? "You cannot remove your own account." : "Remove"}
                        className="px-2 py-1.5 text-[#d63b53] hover:bg-[#fdeaec] hover:text-[#c0334a]"
                      >
                        <Trash2 className="h-[15px] w-[15px]" />
                      </Btn>
                    </div>
                  </Td>
                </tr>
              );
            })}
            {users.length === 0 && (
              <tr>
                <Td className="text-muted-foreground">{indisponible ? "—" : "No accounts yet."}</Td>
                <Td /><Td /><Td /><Td /><Td /><Td />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-start gap-2 text-[12px] text-muted-foreground/80">
        <ShieldCheck className="mt-[1px] h-3.5 w-3.5 shrink-0" />
        <span>
          An administrator sees every brand and every template. A member sees only what is granted
          below — anything else answers as if it did not exist. “All brands” and “All templates” are
          independent: a member can have one brand and every template of that brand, including ones
          added later. Neither gives admin rights, and “All templates” never reaches another brand.
        </span>
      </div>

      {/* ---------------------------------------------------------------- invitation */}
      {inviteOuvert && (
        <Panneau title="Invite a user" onClose={fermer}>
          {lien ? (
            <>
              <LienInvitation url={lien} />
              <div className="mt-4 flex justify-end">
                <Btn variant="dark" onClick={fermer}>
                  Done
                </Btn>
              </div>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-foreground/80">Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="colleague@example.com"
                  className="rounded-[10px] border border-border bg-background px-3 py-2.5 text-[13.5px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                />
              </label>

              <div className="mt-4">
                <div className="mb-1.5 text-[12px] font-medium text-foreground/80">Role</div>
                <div className="flex gap-2">
                  {(["member", "super_admin"] as const).map((r) => (
                    <button
                      key={r}
                      onClick={() => setRoleInvite(r)}
                      className={`rounded-[9px] border px-3 py-2 text-[12.5px] font-medium ${
                        roleInvite === r ? "border-brand bg-brand-soft text-brand-soft-foreground" : "border-border"
                      }`}
                    >
                      {r === "super_admin" ? "Administrator" : "Member"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-4">
                <div className="mb-1.5 text-[12px] font-medium text-foreground/80">Brands</div>
                {roleInvite === "super_admin" ? (
                  <p className="text-[12.5px] text-muted-foreground">
                    An administrator sees every brand — nothing to choose.
                  </p>
                ) : (
                  <>
                    <CaseTout
                      label="All brands"
                      hint={AIDE_MARQUES}
                      checked={toutesMarquesInvite}
                      onChange={setToutesMarquesInvite}
                    />
                    <div className="grid grid-cols-2 gap-x-2 rounded-[10px] border border-border p-1.5">
                      {brands.map((b) => (
                        <Case
                          key={b.id}
                          checked={toutesMarquesInvite || marquesInvite.includes(b.id)}
                          disabled={toutesMarquesInvite}
                          onChange={(on) => setMarquesInvite(bascule(marquesInvite, b.id, on))}
                        >
                          {b.name}
                        </Case>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Les templates un par un ne se choisissent qu'après l'acceptation, depuis « Manage
                  access » — mais « All templates » se pose DÈS l'invitation : sans lui, un compte
                  destiné à tout voir arriverait vide et il faudrait repasser derrière. */}
              {roleInvite === "member" && (
                <div className="mt-4">
                  <div className="mb-1.5 text-[12px] font-medium text-foreground/80">Templates</div>
                  <CaseTout
                    label="All templates"
                    hint={AIDE_TEMPLATES}
                    checked={tousTemplatesInvite}
                    onChange={setTousTemplatesInvite}
                  />
                  <p className="mt-2 text-[11.5px] text-muted-foreground">
                    {tousTemplatesInvite
                      ? "Every template of the brands above, present and future."
                      : "Individual templates are granted afterwards, from “Manage access”."}
                  </p>
                </div>
              )}

              {err && <Erreur>{err}</Erreur>}

              <div className="mt-5 flex justify-end gap-2">
                <Btn onClick={fermer}>Cancel</Btn>
                <Btn variant="dark" onClick={inviter} disabled={busy || email.trim().length === 0}>
                  {busy && <Loader2 className="h-[15px] w-[15px] animate-spin" />} Create link
                </Btn>
              </div>
            </>
          )}
        </Panneau>
      )}

      {/* ---------------------------------------------------------------- édition */}
      {cible && (
        <Panneau title={cible.email} onClose={fermer}>
          <div className="mb-1.5 text-[12px] font-medium text-foreground/80">Role</div>
          <div className="flex gap-2">
            {(["member", "super_admin"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className={`rounded-[9px] border px-3 py-2 text-[12.5px] font-medium ${
                  role === r ? "border-brand bg-brand-soft text-brand-soft-foreground" : "border-border"
                }`}
              >
                {r === "super_admin" ? "Administrator" : "Member"}
              </button>
            ))}
          </div>

          {cible.status === "invited" ? (
            <p className="mt-4 rounded-[10px] border border-border bg-accent/40 px-3 py-2 text-[12.5px] text-muted-foreground">
              This invitation has not been accepted yet. The account becomes active when the person
              sets a password from their link — or when you set one below.
            </p>
          ) : (
            <div className="mt-4">
              <div className="mb-1.5 text-[12px] font-medium text-foreground/80">Status</div>
              <div className="flex gap-2">
                {(["active", "disabled"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatut(s)}
                    className={`rounded-[9px] border px-3 py-2 text-[12.5px] font-medium ${
                      statut === s ? "border-brand bg-brand-soft text-brand-soft-foreground" : "border-border"
                    }`}
                  >
                    {s === "active" ? "Active" : "Disabled"}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                Disabling takes effect on their next request — not when their session expires.
              </p>
            </div>
          )}

          <div className="mt-4">
            <div className="mb-1.5 text-[12px] font-medium text-foreground/80">Password</div>
            <div className="rounded-[10px] border border-border p-3">
              <p className="mb-2.5 text-[11.5px] text-muted-foreground">
                {cible.status === "invited"
                  ? "Setting a password activates this account now; the invitation link stops working."
                  : "Setting a new password signs this person out everywhere."}{" "}
                “Set password” applies it now; Save applies it too. Send it to the person through a
                private channel.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={mdp}
                  onChange={(e) => {
                    setMdp(e.target.value);
                    setMdpCopie(false);
                    setMdpFait("");
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="New password"
                  placeholder={`At least ${MDP_MIN} characters`}
                  className="min-w-0 flex-1 basis-[200px] rounded-[10px] border border-border bg-background px-3 py-2 font-mono text-[12.5px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                />
                <Btn
                  onClick={() => {
                    setMdp(genererMotDePasse());
                    setMdpCopie(false);
                    setMdpFait("");
                  }}
                  className="py-1.5"
                >
                  Generate
                </Btn>
                <Btn
                  disabled={!mdp}
                  onClick={() => {
                    navigator.clipboard.writeText(mdp).then(
                      () => setMdpCopie(true),
                      () => setMdpCopie(false),
                    );
                  }}
                  className="py-1.5"
                >
                  {mdpCopie ? <Check className="h-[15px] w-[15px]" /> : <Copy className="h-[15px] w-[15px]" />}
                  {mdpCopie ? "Copied" : "Copy"}
                </Btn>
              </div>
              <div className="mt-2.5 flex items-center justify-between gap-3">
                <span className="text-[12px] text-emerald-700">{mdpFait}</span>
                <Btn
                  variant="dark"
                  onClick={definirMotDePasse}
                  disabled={busy || mdp.length < MDP_MIN || !!mdpFait}
                  className="shrink-0 py-1.5"
                >
                  {busy && <Loader2 className="h-[15px] w-[15px] animate-spin" />} Set password
                </Btn>
              </div>
            </div>
          </div>

          <div className="mt-4">
            <div className="mb-1.5 text-[12px] font-medium text-foreground/80">Brands</div>
            {role === "super_admin" ? (
              <p className="text-[12.5px] text-muted-foreground">
                An administrator sees every brand and every template.
              </p>
            ) : (
              <>
                <CaseTout
                  label="All brands"
                  hint={AIDE_MARQUES}
                  checked={toutesMarques}
                  onChange={setToutesMarques}
                />
                <div className="grid grid-cols-2 gap-x-2 rounded-[10px] border border-border p-1.5">
                  {brands.map((b) => (
                    <Case
                      key={b.id}
                      checked={toutesMarques || marques.includes(b.id)}
                      disabled={toutesMarques}
                      onChange={(on) => {
                        const suite = bascule(marques, b.id, on);
                        setMarques(suite);
                        // Retirer une marque retire ses templates : les garder produirait un octroi
                        // que la liste des templates, filtrée par marque, ne montrerait jamais.
                        if (!on) {
                          const perdus = new Set((parMarque.get(b.id) ?? []).map((t) => t.id));
                          setTpl((prev) => prev.filter((id) => !perdus.has(id)));
                        }
                      }}
                    >
                      {b.name}
                    </Case>
                  ))}
                </div>
              </>
            )}
          </div>

          {role !== "super_admin" && (
            <div className="mt-4">
              <div className="mb-1.5 text-[12px] font-medium text-foreground/80">Templates</div>
              <CaseTout
                label="All templates"
                hint={AIDE_TEMPLATES}
                checked={tousTemplates}
                onChange={setTousTemplates}
              />
              {marquesDeLaCible.length === 0 ? (
                <p className="text-[12.5px] text-muted-foreground">Grant a brand first.</p>
              ) : (
                <div className="max-h-[240px] space-y-2 overflow-y-auto rounded-[10px] border border-border p-1.5">
                  {marquesDeLaCible.map((assetId) => {
                    const liste = parMarque.get(assetId) ?? [];
                    return (
                      <div key={assetId}>
                        <div className="px-2 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70">
                          {nomMarque.get(assetId) ?? assetId}
                        </div>
                        {liste.length === 0 ? (
                          <div className="px-2 py-1 text-[12px] text-muted-foreground">
                            No template in this brand.
                          </div>
                        ) : (
                          liste.map((t) => (
                            <Case
                              key={t.id}
                              checked={tousTemplates || tpl.includes(t.id)}
                              disabled={tousTemplates}
                              onChange={(on) => setTpl(bascule(tpl, t.id, on))}
                            >
                              {t.name}
                            </Case>
                          ))
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {err && <Erreur>{err}</Erreur>}

          <div className="mt-5 flex justify-end gap-2">
            <Btn onClick={fermer}>Cancel</Btn>
            <Btn variant="dark" onClick={enregistrer} disabled={busy}>
              {busy && <Loader2 className="h-[15px] w-[15px] animate-spin" />} Save
            </Btn>
          </div>
        </Panneau>
      )}
    </div>
  );
}
