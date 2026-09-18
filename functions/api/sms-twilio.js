import { handleTwilioWebhook } from '../../lib/sms-consent.mjs';

export async function onRequestPost({ request, env }) {
  return handleTwilioWebhook(request, env);
}
