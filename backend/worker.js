const ALLOWED_TOPICS = new Set([
  "criminal_justice", "courts_corrections", "housing", "tax_economic_policy",
  "education", "health", "labor", "public_employees", "civil_rights_elections",
  "family_child_welfare", "immigration", "environment_energy", "transportation",
  "technology_privacy", "consumer_protection", "business_licensing",
  "local_government", "disability_veterans", "other"
]);
const ALLOWED_EVENTS = new Set(["new_bill", "hearing", "change"]);
const ALLOWED_FREQUENCIES = new Set(["immediate", "daily", "weekly"]);

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return corsResponse(request, env, "", 204);
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/subscribe") {
        return await subscribe(request, env);
      }
      if (request.method === "GET" && url.pathname === "/confirm") {
        return await confirm(url, env);
      }
      if (request.method === "GET" && url.pathname === "/unsubscribe") {
        return await unsubscribe(url, env);
      }
      if (request.method === "POST" && url.pathname === "/dispatch") {
        return await dispatch(request, env, ctx);
      }
      if (url.pathname === "/health") return jsonResponse({ ok: true });
      return jsonResponse({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error);
      return corsResponse(request, env, JSON.stringify({ error: "The request could not be completed." }), 500, "application/json");
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(sendDigests(env, "daily"));
    if (new Date(controller.scheduledTime).getUTCDay() === 0) {
      ctx.waitUntil(sendDigests(env, "weekly"));
    }
  }
};

function originAllowed(request, env) {
  const origin = request.headers.get("Origin");
  return !origin || origin === env.SITE_ORIGIN || origin === new URL(env.SITE_URL).origin;
}

function corsResponse(request, env, body, status = 200, contentType = "text/plain") {
  if (!originAllowed(request, env)) return new Response("Origin not allowed", { status: 403 });
  const origin = request.headers.get("Origin") || new URL(env.SITE_URL).origin;
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Vary": "Origin",
      "Cache-Control": "no-store"
    }
  });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function token() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizedArray(value, allowed, maximum = 30) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string" && allowed.has(item)))].slice(0, maximum);
}

function validEmail(email) {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function subscribe(request, env) {
  if (!originAllowed(request, env)) return jsonResponse({ error: "Origin not allowed" }, 403);
  const body = await request.json();
  if (body.website) return jsonResponse({ message: "Check your email to confirm your subscription." });
  const email = String(body.email || "").trim().toLowerCase();
  const topics = normalizedArray(body.topics, ALLOWED_TOPICS);
  const events = normalizedArray(body.events, ALLOWED_EVENTS);
  const frequency = ALLOWED_FREQUENCIES.has(body.frequency) ? body.frequency : "daily";
  if (!validEmail(email) || !topics.length || !events.length || body.consent !== true) {
    return corsResponse(request, env, JSON.stringify({ error: "Enter a valid email, choose interests and updates, and provide consent." }), 400, "application/json");
  }

  const now = new Date().toISOString();
  const confirmToken = token();
  const unsubscribeToken = token();
  await env.SUBSCRIBERS.prepare(`
    INSERT INTO subscribers
      (email, topics_json, events_json, frequency, confirm_token, unsubscribe_token,
       confirmed, active, consent_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      topics_json = excluded.topics_json,
      events_json = excluded.events_json,
      frequency = excluded.frequency,
      confirm_token = excluded.confirm_token,
      unsubscribe_token = excluded.unsubscribe_token,
      confirmed = 0,
      active = 1,
      consent_at = excluded.consent_at,
      updated_at = excluded.updated_at
  `).bind(email, JSON.stringify(topics), JSON.stringify(events), frequency, confirmToken, unsubscribeToken, now, now, now).run();

  const confirmUrl = `${new URL(request.url).origin}/confirm?token=${confirmToken}`;
  await sendEmail(env, {
    to: email,
    subject: "Confirm your Maryland Legislative Watch subscription",
    html: emailShell(`
      <h1>Confirm your legislative updates</h1>
      <p>You requested Maryland legislative alerts for ${topics.length} interest area${topics.length === 1 ? "" : "s"}.</p>
      <p><a class="button" href="${confirmUrl}">Confirm subscription</a></p>
      <p>If you did not request this, you can ignore this message.</p>
    `)
  });
  return corsResponse(request, env, JSON.stringify({ message: "Check your email to confirm your subscription." }), 200, "application/json");
}

async function confirm(url, env) {
  const value = url.searchParams.get("token") || "";
  const now = new Date().toISOString();
  const result = await env.SUBSCRIBERS.prepare(`
    UPDATE subscribers SET confirmed = 1, active = 1, confirmed_at = ?, updated_at = ?
    WHERE confirm_token = ?
  `).bind(now, now, value).run();
  const ok = result.meta.changes > 0;
  return htmlPage(ok ? "Subscription confirmed" : "Confirmation link not found", ok
    ? `Your Maryland legislative alerts are active. <a href="${env.SITE_URL}">Return to the tracker</a>.`
    : "This confirmation link is invalid or no longer available.", ok ? 200 : 404);
}

async function unsubscribe(url, env) {
  const value = url.searchParams.get("token") || "";
  const now = new Date().toISOString();
  const result = await env.SUBSCRIBERS.prepare(`
    UPDATE subscribers SET active = 0, unsubscribed_at = ?, updated_at = ?
    WHERE unsubscribe_token = ?
  `).bind(now, now, value).run();
  const ok = result.meta.changes > 0;
  return htmlPage(ok ? "Unsubscribed" : "Unsubscribe link not found", ok
    ? `You will no longer receive Maryland Legislative Watch emails. <a href="${env.SITE_URL}">Return to the tracker</a>.`
    : "This unsubscribe link is invalid or no longer available.", ok ? 200 : 404);
}

async function dispatch(request, env, ctx) {
  if (request.headers.get("Authorization") !== `Bearer ${env.DISPATCH_TOKEN}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const body = await request.json();
  const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
  const now = new Date().toISOString();
  let accepted = 0;
  for (const event of events) {
    if (!event.event_id || !event.bill_number || !ALLOWED_EVENTS.has(event.change_type)) continue;
    await env.SUBSCRIBERS.prepare(`
      INSERT OR IGNORE INTO legislative_events
        (event_id, change_type, bill_number, title, topics_json, data_json, observed_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      String(event.event_id), event.change_type, String(event.bill_number), String(event.title || ""),
      JSON.stringify(normalizedArray(event.topics, ALLOWED_TOPICS)), JSON.stringify(event),
      String(event.observed_at || now), now
    ).run();
    accepted += 1;
  }
  ctx.waitUntil(sendDigests(env, "immediate"));
  return jsonResponse({ accepted, immediate_delivery_started: true });
}

async function sendDigests(env, frequency) {
  const subscribers = await env.SUBSCRIBERS.prepare(`
    SELECT id, email, topics_json, events_json, unsubscribe_token
    FROM subscribers WHERE confirmed = 1 AND active = 1 AND frequency = ?
    ORDER BY id LIMIT 500
  `).bind(frequency).all();
  for (const subscriber of subscribers.results || []) {
    const topics = new Set(JSON.parse(subscriber.topics_json));
    const eventTypes = new Set(JSON.parse(subscriber.events_json));
    const pending = await env.SUBSCRIBERS.prepare(`
      SELECT e.event_id, e.change_type, e.bill_number, e.title, e.topics_json, e.data_json
      FROM legislative_events e
      LEFT JOIN deliveries d ON d.event_id = e.event_id AND d.subscriber_id = ?
      WHERE d.event_id IS NULL
      ORDER BY e.observed_at DESC LIMIT 250
    `).bind(subscriber.id).all();
    const matches = (pending.results || []).filter((row) => {
      const rowTopics = JSON.parse(row.topics_json);
      return eventTypes.has(row.change_type) && rowTopics.some((topic) => topics.has(topic));
    }).slice(0, 40);
    if (!matches.length) continue;
    const unsubscribeUrl = `${env.WORKER_URL}/unsubscribe?token=${subscriber.unsubscribe_token}`;
    const html = digestHtml(matches, env.SITE_URL, unsubscribeUrl);
    const subject = `${matches.length} Maryland legislative update${matches.length === 1 ? "" : "s"}`;
    const sent = await sendEmail(env, { to: subscriber.email, subject, html });
    if (!sent) continue;
    const deliveredAt = new Date().toISOString();
    for (const event of matches) {
      await env.SUBSCRIBERS.prepare(`
        INSERT OR IGNORE INTO deliveries (subscriber_id, event_id, delivered_at) VALUES (?, ?, ?)
      `).bind(subscriber.id, event.event_id, deliveredAt).run();
    }
  }
}

function digestHtml(rows, siteUrl, unsubscribeUrl) {
  const items = rows.map((row) => {
    const event = JSON.parse(row.data_json);
    const actionUrl = `${siteUrl}/?action=${encodeURIComponent(row.bill_number)}#take-action`;
    const billUrl = `${siteUrl}/?bill=${encodeURIComponent(row.bill_number)}#bills`;
    return `<div style="padding:16px 0;border-bottom:1px solid #ddd">
      <h2 style="margin:0 0 6px;font-size:18px">${escapeHtml(row.bill_number)} — ${escapeHtml(row.title)}</h2>
      <p><strong>${escapeHtml(event.field_label || "Update")}:</strong> ${escapeHtml(displayValue(event.new_value))}</p>
      <p><a href="${billUrl}">View the bill</a> · <a href="${actionUrl}">Write about this bill</a></p>
    </div>`;
  }).join("");
  return emailShell(`<h1>Your Maryland legislative updates</h1>${items}
    <p style="font-size:12px;color:#666">You received this because you subscribed to Maryland Legislative Watch. <a href="${unsubscribeUrl}">Unsubscribe</a>.</p>`);
}

function displayValue(value) {
  if (Array.isArray(value)) return value.join("; ");
  if (value == null || value === "") return "Updated";
  return String(value);
}

async function sendEmail(env, message) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, ...message })
  });
  if (!response.ok) {
    console.error("Email failed", response.status, await response.text());
    return false;
  }
  return true;
}

function emailShell(content) {
  return `<!doctype html><html><body style="margin:0;background:#f2c230;font-family:Arial,sans-serif;color:#151515">
    <div style="max-width:640px;margin:24px auto;padding:28px;background:#fffef9;border:3px solid #151515;border-top:12px solid #c8102e">
      ${content}
    </div></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function htmlPage(title, message, status) {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>
    <body style="margin:0;padding:32px;background:#f2c230;font-family:Arial,sans-serif"><main style="max-width:680px;margin:auto;padding:32px;background:#fff;border:3px solid #151515;border-top:12px solid #c8102e"><h1>${escapeHtml(title)}</h1><p>${message}</p></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
