/**
 * Logs JSON structurés. N'écho JAMAIS de secret ni de token complet. Push Slack optionnel
 * uniquement sur les VRAIES erreurs (status 'failed'), jamais sur les 'skipped' intentionnels.
 */
export interface LogFields {
  id?: string;
  kind?: string;
  decision?: string; // would_send | would_skip | sent | skipped | failed
  reason?: string;
  track?: boolean;
  from?: string;
  domain?: string;
  to?: string;
  [k: string]: unknown;
}

export function log(event: string, fields: LogFields = {}): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

export async function slackAlert(webhookUrl: string | undefined, text: string): Promise<void> {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    /* l'alerte ne doit jamais casser le worker */
  }
}
