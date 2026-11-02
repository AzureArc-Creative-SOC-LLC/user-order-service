// order-emails.js
// Per-brand, theme-matched order-confirmation emails sent via TurboSMTP.
//
// The user-order-service is shared by several white-label storefronts. When a
// browser on one of those storefronts places an order, its cross-origin request
// carries an `Origin` header (e.g. https://luxenlabs.shop). We use that to pick
// the matching brand theme and render a confirmation email that looks like that
// specific site — instead of the generic Alluvi template.
//
// Transport: TurboSMTP only (Resend, Mailjet and shared Gmail are no longer
// used). Each storefront domain is housed in one of up to three TurboSMTP
// accounts (TURBOSMTP_{n}_USER/PASS/DOMAINS in .env). A branded email is sent
// through the account whose *_DOMAINS lists theme.domain, as
// "<Brand> <orders@<domain>>" — that domain must be verified (SPF + DKIM) under
// Sender Domain Verification in that account or TurboSMTP rejects the send.
// A domain listed in no account uses TURBOSMTP_FALLBACK_ACCOUNT if set;
// otherwise the send is skipped ({ skipped: 'no-transport' }) — it never falls
// back to another provider or to an Alluvi sender.
//
// Security: all credentials come from process.env (never hard-coded).

import nodemailer from 'nodemailer'

// ── TurboSMTP account resolution ─────────────────────────────────────────────
const TURBOSMTP_MAX_ACCOUNTS = 3
const turboTransports = new Map()

function turboSmtpAccount(n) {
  const user = String(process.env[`TURBOSMTP_${n}_USER`] || '').trim()
  const pass = String(process.env[`TURBOSMTP_${n}_PASS`] || '').trim()
  if (!user || !pass) return null
  const domains = String(process.env[`TURBOSMTP_${n}_DOMAINS`] || '')
    .split(',').map(d => d.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean)
  const port = Number(process.env.TURBOSMTP_PORT) || 587
  return { n, user, pass, domains, host: String(process.env.TURBOSMTP_HOST || 'pro.turbo-smtp.com').trim(), port }
}

// Returns the TurboSMTP account that houses `domain`, the fallback account if
// configured, or null (→ the send is skipped).
function resolveTurboSmtpAccount(domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/^www\./, '')
  const accounts = []
  for (let n = 1; n <= TURBOSMTP_MAX_ACCOUNTS; n++) { const a = turboSmtpAccount(n); if (a) accounts.push(a) }
  if (!accounts.length) return null
  const hit = d && accounts.find(a => a.domains.includes(d))
  if (hit) return hit
  const fb = Number(process.env.TURBOSMTP_FALLBACK_ACCOUNT)
  return accounts.find(a => a.n === fb) || null
}

function turboSmtpTransport(account) {
  const key = `${account.n}:${account.host}:${account.port}:${account.user}`
  let t = turboTransports.get(key)
  if (!t) {
    t = nodemailer.createTransport({
      host: account.host,
      port: account.port,
      secure: account.port === 465,
      auth: { user: account.user, pass: account.pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    })
    turboTransports.set(key, t)
  }
  return t
}

async function sendViaTurboSmtp({ account, from, to, replyTo, subject, html, text, headers, attachments }) {
  try {
    const info = await turboSmtpTransport(account).sendMail({
      from, to, subject, html, text,
      ...(replyTo ? { replyTo } : {}),
      ...(headers && typeof headers === 'object' ? { headers } : {}),
      ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
    })
    return { success: true, messageId: info?.messageId || null, transport: `turbosmtp:${account.n}` }
  } catch (e) {
    return { success: false, error: e?.response || e?.message || String(e), transport: `turbosmtp:${account.n}` }
  }
}

// Sends through the TurboSMTP account housing the sender's domain. Returns
// { skipped: 'no-transport' } when no account is configured for it, else
// { success, messageId, transport }. `from` ({ email, name }) overrides the
// default "<Brand> <orders@<theme.domain>>" sender (used by the main site).
export async function sendBrandedEmail({ theme, to, replyTo, subject, html, text, headers, attachments, from }) {
  const fromEmail = from?.email || `orders@${theme.domain}`
  const fromName = from?.name || theme.brand
  const senderDomain = String(fromEmail).split('@')[1] || theme.domain
  const account = resolveTurboSmtpAccount(senderDomain)
  if (!account) return { skipped: 'no-transport' }
  return sendViaTurboSmtp({ account, from: `${fromName} <${fromEmail}>`, to, replyTo: replyTo || fromEmail, subject, html, text, headers, attachments })
}

// Non-secret summary for startup logs / debugging.
function describeEmailTransports() {
  const accounts = []
  for (let n = 1; n <= TURBOSMTP_MAX_ACCOUNTS; n++) { const a = turboSmtpAccount(n); if (a) accounts.push({ account: n, domains: a.domains }) }
  return { turbosmtp: accounts, fallbackAccount: process.env.TURBOSMTP_FALLBACK_ACCOUNT || null }
}

// ── Per-brand themes (extracted from each site's design tokens) ──────────────
// Keyed by bare domain (no www). Each storefront is matched by its Origin host.
const BRAND_THEMES = {
  'luxenlabs.shop': {
    key: 'luxen', brand: 'Luxen', domain: 'luxenlabs.shop',
    tagline: 'Reclaim Your Results.', currency: '$',
    bg: '#ffffff', surface: '#faf8f4', heading: '#14202a', body: '#14202a',
    muted: '#5f6c6c', accent: '#4e493e', accentText: '#ffffff', border: '#e1e9e8',
    fontHeading: "'Space Grotesk', Arial, sans-serif",
    fontBody: "'Space Grotesk', Arial, sans-serif",
  },
  'peptiqlabs.io': {
    key: 'peptiq', brand: 'Peptiq', domain: 'peptiqlabs.io',
    tagline: 'Driven by Science, Proven by You.', currency: '$',
    bg: '#ffffff', surface: '#faf8f4', heading: '#14202a', body: '#14202a',
    muted: '#5f6c6c', accent: '#4e493e', accentText: '#ffffff', border: '#e1e9e8',
    fontHeading: "'Space Grotesk', Arial, sans-serif",
    fontBody: "'Space Grotesk', Arial, sans-serif",
  },
  'zyrahealthcare.com': {
    key: 'zyra', brand: 'Zyra Labs', domain: 'zyrahealthcare.com',
    tagline: 'Unlock Your Ultimate Self.', currency: '$',
    bg: '#ffffff', surface: '#faf8f4', heading: '#14202a', body: '#14202a',
    muted: '#5f6c6c', accent: '#4e493e', accentText: '#ffffff', border: '#e1e9e8',
    fontHeading: "'Space Grotesk', Arial, sans-serif",
    fontBody: "'Space Grotesk', Arial, sans-serif",
  },
    'jupyterlabs.net': {
    key: 'jupyterlabs', brand: 'Jupyter Labs', domain: 'jupyterlabs.net',
    tagline: 'Transform From the Inside Out.', currency: '$',
    bg: '#ffffff', surface: '#faf8f4', heading: '#14202a', body: '#14202a',
    muted: '#5f6c6c', accent: '#4e493e', accentText: '#ffffff', border: '#e1e9e8',
    fontHeading: "'Space Grotesk', Arial, sans-serif",
    fontBody: "'Space Grotesk', Arial, sans-serif",
  },

  'vyralabs.co': {
    key: 'vyra', brand: 'Vyra Health', domain: 'vyralabs.co',
    tagline: 'Fuel the Change.', currency: '$',
    bg: '#ffffff', surface: '#faf8f4', heading: '#14202a', body: '#14202a',
    muted: '#5f6c6c', accent: '#4e493e', accentText: '#ffffff', border: '#e1e9e8',
    fontHeading: "'Space Grotesk', Arial, sans-serif",
    fontBody: "'Space Grotesk', Arial, sans-serif",
  },
  'lumivexlabs.co': {
    key: 'lumivex', brand: 'Lumivex Labs', domain: 'lumivexlabs.co',
    tagline: 'Modern Science for Modern Wellness.', currency: '$',
    bg: '#ffffff', surface: '#faf8f4', heading: '#14202a', body: '#14202a',
    muted: '#5f6c6c', accent: '#4e493e', accentText: '#ffffff', border: '#e1e9e8',
    fontHeading: "'Space Grotesk', Arial, sans-serif",
    fontBody: "'Space Grotesk', Arial, sans-serif",
  },
  'noverafitness.com': {
    key: 'novera', brand: 'Novera Fitness', domain: 'noverafitness.com',
    tagline: 'Target the Change.', currency: '$',
    bg: '#ffffff', surface: '#faf8f4', heading: '#14202a', body: '#14202a',
    muted: '#5f6c6c', accent: '#4e493e', accentText: '#ffffff', border: '#e1e9e8',
    fontHeading: "'Space Grotesk', Arial, sans-serif",
    fontBody: "'Space Grotesk', Arial, sans-serif",
  },
  // 'jupyterlabs.net': {
  //   key: 'jupyterlabs', brand: 'Jupyter Labs', domain: 'jupyterlabs.net',
  //   tagline: 'Pharmaceutical rigor, in every vial.', currency: '£',
  //   bg: '#ffffff', surface: '#eef5f4', heading: '#14202a', body: '#14202a',
  //   muted: '#5f6c6c', accent: '#14b8a6', accentText: '#ffffff', border: '#e1e9e8',
  //   fontHeading: "'Space Grotesk', Arial, sans-serif",
  //   fontBody: "'Space Grotesk', Arial, sans-serif",
  // },
  
  'vorahealthcare.com': {
    key: 'vora', brand: 'Vora Healthcare', domain: 'vorahealthcare.com',
    tagline: 'Your Body, Upgraded.', currency: '$',
    bg: '#ffffff', surface: '#faf8f4', heading: '#14202a', body: '#14202a',
    muted: '#5f6c6c', accent: '#4e493e', accentText: '#ffffff', border: '#e1e9e8',
    fontHeading: "'Space Grotesk', Arial, sans-serif",
    fontBody: "'Space Grotesk', Arial, sans-serif",
  },
  'liorahealthcare.com': {
    key: 'liora', brand: 'Liora Healthcare', domain: 'liorahealthcare.com',
    tagline: 'Redefining the Standard.', currency: '$',
    bg: '#ffffff', surface: '#faf8f4', heading: '#14202a', body: '#14202a',
    muted: '#5f6c6c', accent: '#4e493e', accentText: '#ffffff', border: '#e1e9e8',
    fontHeading: "'Space Grotesk', Arial, sans-serif",
    fontBody: "'Space Grotesk', Arial, sans-serif",
  },
  'peptivalabs.uk': {
    key: 'peptiva', brand: 'Peptiva Labs', domain: 'peptivalabs.uk',
    tagline: 'Designed for the Dedicated.', currency: '$',
    bg: '#ffffff', surface: '#faf8f4', heading: '#14202a', body: '#14202a',
    muted: '#5f6c6c', accent: '#4e493e', accentText: '#ffffff', border: '#e1e9e8',
    fontHeading: "'Space Grotesk', Arial, sans-serif",
    fontBody: "'Space Grotesk', Arial, sans-serif",
  },
}

// Aliases so a frontend can also pass an explicit `brand` key if it wants to.
const BRAND_BY_KEY = Object.fromEntries(
  Object.values(BRAND_THEMES).map((t) => [t.key, t])
)

// Fallback theme for requests that don't match a white-label storefront (e.g.
// the main Alluvi site itself). Same light, card-based look as the branded
// storefronts get — nothing should ever fall back to a bespoke design.
const DEFAULT_THEME = {
  key: 'alluvi', brand: 'Alluvi', domain: 'alluvi.store',
  tagline: 'Fuel the Shift.', currency: '£',
    bg: '#ffffff', surface: '#faf8f4', heading: '#14202a', body: '#14202a',
    muted: '#5f6c6c', accent: '#4e493e', accentText: '#ffffff', border: '#e1e9e8',
    fontHeading: "'Space Grotesk', Arial, sans-serif",
    fontBody: "'Space Grotesk', Arial, sans-serif",
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function bareHost(value) {
  if (!value) return ''
  try {
    const u = new URL(String(value))
    return u.host.replace(/^www\./i, '').toLowerCase()
  } catch {
    return String(value).replace(/^www\./i, '').trim().toLowerCase()
  }
}

// Resolve the brand theme for an order. Priority: explicit payload brand/domain,
// then the request Origin, then Referer. Returns null if no storefront matches.
function resolveBrandTheme(req, payload = {}) {
  const explicit = payload.brand || payload.store || payload.storeKey
  if (explicit && BRAND_BY_KEY[String(explicit).toLowerCase()]) {
    return BRAND_BY_KEY[String(explicit).toLowerCase()]
  }
  const explicitDomain = bareHost(payload.storeDomain || payload.storeUrl)
  if (explicitDomain && BRAND_THEMES[explicitDomain]) return BRAND_THEMES[explicitDomain]

  const headers = (req && req.headers) || {}
  const originHost = bareHost(headers['origin'])
  if (originHost && BRAND_THEMES[originHost]) return BRAND_THEMES[originHost]
  const refHost = bareHost(headers['referer'] || headers['referrer'])
  if (refHost && BRAND_THEMES[refHost]) return BRAND_THEMES[refHost]
  return null
}

function money(theme, n) {
  const num = Number(n)
  return `${theme.currency}${(Number.isFinite(num) ? num : 0).toFixed(2)}`
}

// Build the { items, subtotal, discount, shipping, total, address } view model
// from a raw checkout payload.
function orderViewFromPayload(payload = {}, orderNumber = '', customerName = '') {
  const rawItems = Array.isArray(payload.itemsArray)
    ? payload.itemsArray
    : Array.isArray(payload.items) ? payload.items : []
  const items = rawItems
    .map((it) => {
      const name = String(it.name || it.title || '').trim()
      const quantity = Math.max(Number(it.quantity || it.qty || 1), 1)
      const unitPrice = Number(it.unitPrice ?? it.price ?? 0) || 0
      return { name, quantity, unitPrice, lineTotal: Number((unitPrice * quantity).toFixed(2)) }
    })
    .filter((it) => it.name)

  const subtotal = Number(payload.subtotal) || items.reduce((s, it) => s + it.lineTotal, 0)
  const discount = Number(payload.discountAmount ?? payload.discount ?? 0) || 0
  const total = Number(payload.total)
  const totalSafe = Number.isFinite(total) ? total : Math.max(subtotal - discount, 0)
  // Shipping is whatever's left once subtotal and discount are accounted for.
  const shipping = Number((totalSafe - subtotal + discount).toFixed(2))

  return {
    orderNumber,
    customerName: customerName || 'Customer',
    firstName: (customerName || '').trim().split(/\s+/)[0] || 'there',
    items,
    subtotal,
    discount,
    shipping: shipping > 0.009 ? shipping : 0,
    total: totalSafe,
    promoCode: payload.promoCode || payload.promo_code || null,
    address: {
      line: String(payload.address || payload.shippingAddress || '').trim(),
      city: String(payload.city || payload.shippingCity || '').trim(),
      postcode: String(payload.postcode || payload.shippingZip || '').trim(),
      country: String(payload.country || payload.shippingCountry || '').trim(),
    },
  }
}

function renderOrderEmailHtml(theme, order) {
  const t = theme
  const itemRows = order.items.map((it) => `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid ${t.border};font-family:${t.fontBody};font-size:15px;color:${t.body};line-height:1.4;">
        <span style="display:block;font-weight:600;">${escapeHtml(it.name)}</span>
        <span style="display:block;color:${t.muted};font-size:13px;margin-top:2px;">Qty ${it.quantity} &times; ${money(t, it.unitPrice)}</span>
      </td>
      <td align="right" style="padding:14px 0;border-bottom:1px solid ${t.border};font-family:${t.fontBody};font-size:15px;color:${t.body};white-space:nowrap;vertical-align:top;font-weight:600;">
        ${money(t, it.lineTotal)}
      </td>
    </tr>`).join('')

  const totalsRow = (label, value, opts = {}) => `
    <tr>
      <td style="padding:${opts.big ? '12px' : '5px'} 0 ${opts.big ? '0' : '5px'};font-family:${t.fontBody};font-size:${opts.big ? '17px' : '14px'};color:${opts.big ? t.heading : t.muted};${opts.big ? 'font-weight:700;border-top:2px solid ' + t.border + ';' : ''}">${escapeHtml(label)}</td>
      <td align="right" style="padding:${opts.big ? '12px' : '5px'} 0 ${opts.big ? '0' : '5px'};font-family:${t.fontBody};font-size:${opts.big ? '17px' : '14px'};color:${opts.big ? t.heading : t.body};font-weight:${opts.big ? '700' : '500'};${opts.big ? 'border-top:2px solid ' + t.border + ';' : ''}white-space:nowrap;">${escapeHtml(value)}</td>
    </tr>`

  const addr = order.address
  const addressBlock = [addr.line, [addr.city, addr.postcode].filter(Boolean).join(', '), addr.country]
    .filter(Boolean).map((l) => escapeHtml(l)).join('<br>')

  const discountRow = order.discount > 0
    ? totalsRow(`Discount${order.promoCode ? ' (' + escapeHtml(order.promoCode) + ')' : ''}`, `-${money(t, order.discount)}`)
    : ''
  const shippingRow = totalsRow('Shipping', order.shipping > 0 ? money(t, order.shipping) : 'Free')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting"><title>Order ${escapeHtml(order.orderNumber)}</title></head>
<body style="margin:0;padding:0;background:${t.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your ${escapeHtml(t.brand)} order ${escapeHtml(order.orderNumber)} is confirmed.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.bg};padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${t.surface};border:1px solid ${t.border};border-radius:14px;overflow:hidden;">
      <!-- Header -->
      <tr><td style="padding:34px 40px 24px;text-align:center;border-bottom:1px solid ${t.border};">
        <div style="font-family:${t.fontHeading};font-size:24px;letter-spacing:3px;font-weight:700;color:${t.heading};text-transform:uppercase;">${escapeHtml(t.brand)}</div>
        <div style="font-family:${t.fontBody};font-size:13px;color:${t.muted};margin-top:8px;">${escapeHtml(t.tagline)}</div>
      </td></tr>
      <!-- Confirmation -->
      <tr><td style="padding:36px 40px 8px;">
        <div style="display:inline-block;background:${t.accent};color:${t.accentText};font-family:${t.fontBody};font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:7px 14px;border-radius:999px;">Order confirmed</div>
        <h1 style="font-family:${t.fontHeading};font-size:26px;line-height:1.25;color:${t.heading};margin:18px 0 6px;font-weight:700;">Thank you, ${escapeHtml(order.firstName)}.</h1>
        <p style="font-family:${t.fontBody};font-size:15px;line-height:1.6;color:${t.muted};margin:0;">We've received your order and it's being prepared. Your order reference is <strong style="color:${t.heading};">${escapeHtml(order.orderNumber)}</strong>.</p>
      </td></tr>
      <!-- Items -->
      <tr><td style="padding:24px 40px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemRows}</table>
      </td></tr>
      <!-- Totals -->
      <tr><td style="padding:8px 40px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${totalsRow('Subtotal', money(t, order.subtotal))}
          ${discountRow}
          ${shippingRow}
          ${totalsRow('Total', money(t, order.total), { big: true })}
        </table>
      </td></tr>
      <!-- Shipping + payment -->
      <tr><td style="padding:28px 40px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td width="50%" valign="top" style="font-family:${t.fontBody};font-size:13px;color:${t.body};line-height:1.6;">
            <div style="color:${t.muted};text-transform:uppercase;letter-spacing:1px;font-size:11px;font-weight:700;margin-bottom:6px;">Shipping to</div>
            ${addressBlock || '<span style="color:' + t.muted + ';">—</span>'}
          </td>
          <td width="50%" valign="top" style="font-family:${t.fontBody};font-size:13px;color:${t.body};line-height:1.6;">
            <div style="color:${t.muted};text-transform:uppercase;letter-spacing:1px;font-size:11px;font-weight:700;margin-bottom:6px;">Payment</div>
            Bank transfer &mdash; we'll email secure payment instructions shortly.
          </td>
        </tr></table>
      </td></tr>
      <!-- CTA -->
      <tr><td style="padding:30px 40px 8px;">
        <a href="https://${escapeHtml(t.domain)}" style="display:block;background:${t.accent};color:${t.accentText};font-family:${t.fontBody};font-size:15px;font-weight:700;text-decoration:none;text-align:center;padding:15px 24px;border-radius:10px;">Visit ${escapeHtml(t.brand)}</a>
      </td></tr>
      <!-- Footer -->
      <tr><td style="padding:26px 40px 34px;text-align:center;">
        <div style="font-family:${t.fontBody};font-size:12px;color:${t.muted};line-height:1.6;">
          ${escapeHtml(t.brand)} &middot; <a href="https://${escapeHtml(t.domain)}" style="color:${t.muted};">${escapeHtml(t.domain)}</a><br>
          For laboratory research use only. Not for human or veterinary consumption.<br>
          You received this email because an order was placed with this address.
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`
}

function renderOrderEmailText(theme, order) {
  const lines = [
    `${theme.brand} — Order confirmed`,
    ``,
    `Thank you, ${order.firstName}. We've received your order ${order.orderNumber}.`,
    ``,
    ...order.items.map((it) => `- ${it.name} x${it.quantity} — ${money(theme, it.lineTotal)}`),
    ``,
    `Subtotal: ${money(theme, order.subtotal)}`,
    ...(order.discount > 0 ? [`Discount: -${money(theme, order.discount)}`] : []),
    `Shipping: ${order.shipping > 0 ? money(theme, order.shipping) : 'Free'}`,
    `Total: ${money(theme, order.total)}`,
    ``,
    `Payment by bank transfer — we'll email secure instructions shortly.`,
    ``,
    `${theme.brand} · ${theme.domain}`,
    `For laboratory research use only. Not for human or veterinary consumption.`,
  ]
  return lines.join('\n')
}

// Main entry: send a brand-themed order confirmation.
// Returns { skipped } when no storefront matches (caller should fall back to the
// generic email) or when no TurboSMTP account is configured for the storefront. Returns { success } on send.
export async function sendBrandedOrderConfirmation({ req, to, payload, orderNumber, customerName }) {
  const theme = resolveBrandTheme(req, payload || {})
  if (!theme) return { skipped: 'no-brand-match' }

  if (!to || !String(to).includes('@')) return { skipped: 'no-recipient', brand: theme.key }

  const order = orderViewFromPayload(payload || {}, String(orderNumber || '').trim(), customerName)
  const subject = `Your ${theme.brand} order ${order.orderNumber} is confirmed`

  const result = await sendBrandedEmail({
    theme,
    to,
    subject,
    html: renderOrderEmailHtml(theme, order),
    text: renderOrderEmailText(theme, order),
  })
  return { ...result, brand: theme.key }
}

// ── Password reset email — same light, card-based look as order confirmations ──

function renderPasswordResetEmailHtml(theme, { userName, resetLink }) {
  const t = theme
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting"><title>Reset Your ${escapeHtml(t.brand)} Password</title></head>
<body style="margin:0;padding:0;background:${t.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Reset your ${escapeHtml(t.brand)} password — this link expires in 1 hour.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.bg};padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${t.surface};border:1px solid ${t.border};border-radius:14px;overflow:hidden;">
      <!-- Header -->
      <tr><td style="padding:34px 40px 24px;text-align:center;border-bottom:1px solid ${t.border};">
        <div style="font-family:${t.fontHeading};font-size:24px;letter-spacing:3px;font-weight:700;color:${t.heading};text-transform:uppercase;">${escapeHtml(t.brand)}</div>
        <div style="font-family:${t.fontBody};font-size:13px;color:${t.muted};margin-top:8px;">${escapeHtml(t.tagline)}</div>
      </td></tr>
      <!-- Message -->
      <tr><td style="padding:36px 40px 8px;">
        <h1 style="font-family:${t.fontHeading};font-size:26px;line-height:1.25;color:${t.heading};margin:0 0 12px;font-weight:700;">Hi ${escapeHtml(userName)},</h1>
        <p style="font-family:${t.fontBody};font-size:15px;line-height:1.6;color:${t.muted};margin:0;">We received a request to reset your password for your ${escapeHtml(t.brand)} account. Click the button below to create a new password:</p>
      </td></tr>
      <!-- CTA -->
      <tr><td style="padding:26px 40px 0;text-align:center;">
        <a href="${resetLink}" style="display:inline-block;background:${t.accent};color:${t.accentText};font-family:${t.fontBody};font-size:15px;font-weight:700;text-decoration:none;text-align:center;padding:15px 36px;border-radius:10px;">Reset Password</a>
      </td></tr>
      <tr><td style="padding:22px 40px 0;">
        <p style="font-family:${t.fontBody};font-size:13px;line-height:1.6;color:${t.muted};margin:0;">This link will expire in 1 hour for security reasons.</p>
      </td></tr>
      <!-- Security notice -->
      <tr><td style="padding:20px 40px 0;">
        <div style="background:${t.bg};border:1px solid ${t.border};border-left:4px solid ${t.accent};border-radius:8px;padding:14px 16px;">
          <p style="margin:0;font-family:${t.fontBody};font-size:13px;line-height:1.5;color:${t.body};"><strong>Security notice:</strong> If you didn't request this password reset, you can safely ignore this email — your account is safe and no changes have been made.</p>
        </div>
      </td></tr>
      <!-- Fallback link -->
      <tr><td style="padding:20px 40px 0;">
        <p style="font-family:${t.fontBody};font-size:12px;line-height:1.6;color:${t.muted};margin:0 0 4px;">If the button doesn't work, copy and paste this link into your browser:</p>
        <p style="font-family:${t.fontBody};font-size:12px;word-break:break-all;color:${t.accent};margin:0;">${escapeHtml(resetLink)}</p>
      </td></tr>
      <!-- Footer -->
      <tr><td style="padding:30px 40px 34px;text-align:center;">
        <div style="font-family:${t.fontBody};font-size:12px;color:${t.muted};line-height:1.6;border-top:1px solid ${t.border};padding-top:20px;">
          ${escapeHtml(t.brand)} &middot; <a href="https://${escapeHtml(t.domain)}" style="color:${t.muted};">${escapeHtml(t.domain)}</a><br>
          &copy; ${new Date().getFullYear()} ${escapeHtml(t.brand)}. All rights reserved.
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`
}

function renderPasswordResetEmailText(theme, { userName, resetLink }) {
  const lines = [
    `${theme.brand} — Reset your password`,
    ``,
    `Hi ${userName},`,
    `We received a request to reset your password for your ${theme.brand} account.`,
    ``,
    `Reset your password: ${resetLink}`,
    ``,
    `This link will expire in 1 hour for security reasons.`,
    `If you didn't request this, you can safely ignore this email.`,
    ``,
    `${theme.brand} · ${theme.domain}`,
  ]
  return lines.join('\n')
}

// Main entry: send a brand-themed password reset email. Resolves the storefront
// the same way order confirmations do — explicit payload brand/store/domain
// first, then the request Origin/Referer (falling back to the generic Alluvi
// theme so nothing ever falls back to a bespoke, unbranded design) — and sends
// from that storefront's own domain (orders@<domain>) so the "From" address
// matches the site the user actually signed up on.
// Returns { skipped } when no TurboSMTP account is configured for the storefront.
// Returns { success } on send.
export async function sendBrandedPasswordResetEmail({ req, to, resetLink, userName, payload }) {
  const theme = resolveBrandTheme(req, payload || {}) || DEFAULT_THEME

  if (!to || !String(to).includes('@')) return { skipped: 'no-recipient', brand: theme.key, theme }

  const subject = `Reset Your ${theme.brand} Password`
  const view = { userName: userName || 'there', resetLink }

  const result = await sendBrandedEmail({
    theme,
    to,
    subject,
    html: renderPasswordResetEmailHtml(theme, view),
    text: renderPasswordResetEmailText(theme, view),
  })
  return { ...result, brand: theme.key, theme }
}

// ── Bench Programme waitlist email — same light, card-based look ─────────────
// Sent when a visitor registers interest via the "Join the programme" form
// (POST /api/newsletter/subscribe with source=bench_programme). Email-collection
// only: deliberately quotes no programme terms, since none are confirmed yet.

// `unsubscribeUrl` is the signed one-click link built by the subscribe route
// (GET /api/newsletter/unsubscribe?id=&t=). Falls back to a mailto only if the
// caller couldn't build one.
function renderBenchWaitlistEmailHtml(theme, { unsubscribeUrl } = {}) {
  const t = theme
  const unsubscribeHref = unsubscribeUrl || `mailto:orders@${t.domain}?subject=Unsubscribe`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting"><title>Welcome to the ${escapeHtml(t.brand)} Bench Programme</title></head>
<body style="margin:0;padding:0;background:${t.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">The ${escapeHtml(t.brand)} Bench Programme is launching soon — you're on the early list.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.bg};padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${t.surface};border:1px solid ${t.border};border-radius:14px;overflow:hidden;">
      <!-- Header -->
      <tr><td style="padding:34px 40px 24px;text-align:center;border-bottom:1px solid ${t.border};">
        <div style="font-family:${t.fontHeading};font-size:24px;letter-spacing:3px;font-weight:700;color:${t.heading};text-transform:uppercase;">${escapeHtml(t.brand)}</div>
        <div style="font-family:${t.fontBody};font-size:13px;color:${t.muted};margin-top:8px;">${escapeHtml(t.tagline)}</div>
      </td></tr>
      <!-- Message -->
      <tr><td style="padding:36px 40px 8px;">
        <h1 style="font-family:${t.fontHeading};font-size:26px;line-height:1.25;color:${t.heading};margin:0 0 12px;font-weight:700;">Welcome aboard!</h1>
        <p style="font-family:${t.fontBody};font-size:15px;line-height:1.6;color:${t.body};margin:0 0 14px;">Our <strong>Bench Programme</strong> is launching soon, and we're thrilled to have you with us from day one.</p>
        <p style="font-family:${t.fontBody};font-size:15px;line-height:1.6;color:${t.body};margin:0;">Expect early access and special benefits delivered straight to your inbox before public release.</p>
      </td></tr>
      <tr><td style="padding:22px 40px 0;">
        <p style="font-family:${t.fontBody};font-size:13px;line-height:1.6;color:${t.muted};margin:0;">There's nothing you need to do right now — we'll email you here as soon as it's time.</p>
      </td></tr>
      <tr><td style="padding:26px 40px 0;">
        <p style="font-family:${t.fontBody};font-size:15px;line-height:1.6;color:${t.body};margin:0;">Kind regards,<br>The ${escapeHtml(t.brand)} team</p>
      </td></tr>
      <!-- Footer -->
      <tr><td style="padding:30px 40px 34px;text-align:center;">
        <div style="font-family:${t.fontBody};font-size:12px;color:${t.muted};line-height:1.6;border-top:1px solid ${t.border};padding-top:20px;">
          ${escapeHtml(t.brand)} &middot; <a href="https://${escapeHtml(t.domain)}" style="color:${t.muted};">${escapeHtml(t.domain)}</a><br>
          &copy; ${new Date().getFullYear()} ${escapeHtml(t.brand)}. All rights reserved.<br>
          You're receiving this because you registered interest in the Bench Programme at ${escapeHtml(t.domain)}.
          <a href="${escapeHtml(unsubscribeHref)}" style="color:${t.muted};">Unsubscribe</a>
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`
}

function renderBenchWaitlistEmailText(theme, { unsubscribeUrl } = {}) {
  const lines = [
    `${theme.brand} — Welcome to the Bench Programme`,
    ``,
    `Welcome aboard! Our Bench Programme is launching soon, and we're thrilled`,
    `to have you with us from day one.`,
    ``,
    `Expect early access and special benefits delivered straight to your inbox`,
    `before public release.`,
    ``,
    `There's nothing you need to do right now — we'll email you here as soon`,
    `as it's time.`,
    ``,
    `Kind regards,`,
    `The ${theme.brand} team`,
    ``,
    `${theme.brand} · ${theme.domain}`,
    `You're receiving this because you registered interest in the Bench Programme at ${theme.domain}.`,
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : `To opt out, reply with "unsubscribe".`,
  ]
  return lines.join('\n')
}

// Landing page shown after the unsubscribe link is followed. `status` is one of
// 'done' (just unsubscribed), 'already' (was already off the list) or
// 'invalid' (bad/forged link).
function renderUnsubscribePageHtml(theme, { status, email } = {}) {
  const t = theme
  const copy = {
    done: { title: "You've been unsubscribed", body: `${email ? `<strong>${escapeHtml(email)}</strong> has` : 'This address has'} been removed from the ${escapeHtml(t.brand)} email list. You won't receive any further emails from it.` },
    already: { title: "You're already unsubscribed", body: `This address was already removed from the ${escapeHtml(t.brand)} email list. No further action is needed.` },
    invalid: { title: 'This link is not valid', body: `We couldn't verify this unsubscribe link. Please use the link from the most recent email we sent you, or contact us at <a href="mailto:orders@${escapeHtml(t.domain)}" style="color:${t.accent};">orders@${escapeHtml(t.domain)}</a>.` },
  }[status] || { title: 'Something went wrong', body: 'Please try again later.' }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(copy.title)} — ${escapeHtml(t.brand)}</title></head>
<body style="margin:0;padding:0;background:${t.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.bg};padding:48px 12px;min-height:100vh;">
  <tr><td align="center">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="width:520px;max-width:520px;background:${t.surface};border:1px solid ${t.border};border-radius:14px;overflow:hidden;">
      <tr><td style="padding:34px 40px 24px;text-align:center;border-bottom:1px solid ${t.border};">
        <div style="font-family:${t.fontHeading};font-size:24px;letter-spacing:3px;font-weight:700;color:${t.heading};text-transform:uppercase;">${escapeHtml(t.brand)}</div>
        <div style="font-family:${t.fontBody};font-size:13px;color:${t.muted};margin-top:8px;">${escapeHtml(t.tagline)}</div>
      </td></tr>
      <tr><td style="padding:36px 40px 8px;">
        <h1 style="font-family:${t.fontHeading};font-size:24px;line-height:1.25;color:${t.heading};margin:0 0 12px;font-weight:700;">${escapeHtml(copy.title)}</h1>
        <p style="font-family:${t.fontBody};font-size:15px;line-height:1.6;color:${t.body};margin:0;">${copy.body}</p>
      </td></tr>
      <tr><td style="padding:26px 40px 36px;text-align:center;">
        <a href="https://${escapeHtml(t.domain)}" style="display:inline-block;background:${t.accent};color:${t.accentText};font-family:${t.fontBody};font-size:14px;font-weight:700;text-decoration:none;padding:13px 28px;border-radius:10px;">Back to ${escapeHtml(t.brand)}</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`
}

// Main entry: send the brand-themed Bench Programme waitlist email. Resolves the
// storefront the same way password resets do (explicit payload brand/store/
// domain, then Origin/Referer, then the generic theme) and sends as that brand
// from orders@<domain>. Returns { skipped } when no TurboSMTP account is
// configured for the storefront.
// RFC 8058 one-click headers: Gmail/Apple Mail show a native "Unsubscribe"
// button and POST to the URL without the user opening the page.
function benchUnsubscribeHeaders(theme, unsubscribeUrl) {
  const mailto = `mailto:orders@${theme.domain}?subject=Unsubscribe`
  return {
    'List-Unsubscribe': unsubscribeUrl ? `<${unsubscribeUrl}>, <${mailto}>` : `<${mailto}>`,
    ...(unsubscribeUrl ? { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}),
  }
}

export async function sendBrandedBenchWaitlistEmail({ req, to, payload, unsubscribeUrl }) {
  const theme = resolveBrandTheme(req, payload || {}) || DEFAULT_THEME

  if (!to || !String(to).includes('@')) return { skipped: 'no-recipient', brand: theme.key, theme }

  const subject = `Welcome aboard — the ${theme.brand} Bench Programme is coming soon`

  const result = await sendBrandedEmail({
    theme,
    to,
    subject,
    html: renderBenchWaitlistEmailHtml(theme, { unsubscribeUrl }),
    text: renderBenchWaitlistEmailText(theme, { unsubscribeUrl }),
    headers: benchUnsubscribeHeaders(theme, unsubscribeUrl),
  })
  return { ...result, brand: theme.key, theme }
}

// ── Giveaway entry confirmation — same card-based look, branded per storefront ─
// Sent when a visitor enters the giveaway on a white-label storefront
// (POST /api/newsletter/subscribe, any source other than bench_programme).
// The main Alluvi site keeps its own template (emailService.sendNewsletterEntryEmail).

function renderGiveawayEntryEmailHtml(theme, { productName, unsubscribeUrl } = {}) {
  const t = theme
  const prize = escapeHtml(productName || 'prize')
  const unsubscribeHref = unsubscribeUrl || `mailto:orders@${t.domain}?subject=Unsubscribe`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting"><title>You're in the ${escapeHtml(t.brand)} draw</title></head>
<body style="margin:0;padding:0;background:${t.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">We've got you down for this month's draw.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.bg};padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${t.surface};border:1px solid ${t.border};border-radius:14px;overflow:hidden;">
      <!-- Header -->
      <tr><td style="padding:34px 40px 24px;text-align:center;border-bottom:1px solid ${t.border};">
        <div style="font-family:${t.fontHeading};font-size:24px;letter-spacing:3px;font-weight:700;color:${t.heading};text-transform:uppercase;">${escapeHtml(t.brand)}</div>
        <div style="font-family:${t.fontBody};font-size:13px;color:${t.muted};margin-top:8px;">${escapeHtml(t.tagline)}</div>
      </td></tr>
      <!-- Message -->
      <tr><td style="padding:36px 40px 8px;">
        <h1 style="font-family:${t.fontHeading};font-size:26px;line-height:1.25;color:${t.heading};margin:0 0 12px;font-weight:700;">Thanks for entering</h1>
        <p style="font-family:${t.fontBody};font-size:15px;line-height:1.6;color:${t.body};margin:0 0 14px;">We've got you down for this month's draw. The prize is a free <strong>${prize}</strong>, picked at the end of the month.</p>
        <p style="font-family:${t.fontBody};font-size:15px;line-height:1.6;color:${t.body};margin:0;">If your email is the one drawn, you'll hear from us directly at this address. There's nothing else you need to do right now.</p>
      </td></tr>
      <tr><td style="padding:26px 40px 0;">
        <p style="font-family:${t.fontBody};font-size:15px;line-height:1.6;color:${t.body};margin:0;">Good luck,<br>The ${escapeHtml(t.brand)} team</p>
      </td></tr>
      <!-- Footer -->
      <tr><td style="padding:30px 40px 34px;text-align:center;">
        <div style="font-family:${t.fontBody};font-size:12px;color:${t.muted};line-height:1.6;border-top:1px solid ${t.border};padding-top:20px;">
          ${escapeHtml(t.brand)} &middot; <a href="https://${escapeHtml(t.domain)}" style="color:${t.muted};">${escapeHtml(t.domain)}</a><br>
          &copy; ${new Date().getFullYear()} ${escapeHtml(t.brand)}. All rights reserved.<br>
          You're receiving this because you entered the giveaway at ${escapeHtml(t.domain)}.
          <a href="${escapeHtml(unsubscribeHref)}" style="color:${t.muted};">Unsubscribe</a>
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`
}

function renderGiveawayEntryEmailText(theme, { productName, unsubscribeUrl } = {}) {
  return [
    `${theme.brand} — Thanks for entering`,
    ``,
    `We've got you down for this month's draw.`,
    `The prize is a free ${productName || 'prize'}, picked at the end of the month.`,
    ``,
    `If your email is the one drawn, you'll hear from us directly at this`,
    `address. Nothing else for you to do right now.`,
    ``,
    `Good luck,`,
    `The ${theme.brand} team`,
    ``,
    `${theme.brand} · ${theme.domain}`,
    `You're receiving this because you entered the giveaway at ${theme.domain}.`,
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : `To opt out, reply with "unsubscribe".`,
  ].join('\n')
}

// Returns { skipped: 'no-brand-match' } when the request isn't from a white-label
// storefront, so the caller can use the main Alluvi giveaway template instead.
// Otherwise sends as that brand from orders@<domain> and returns { success, ... }.
export async function sendBrandedGiveawayEntryEmail({ req, to, payload, productName, unsubscribeUrl }) {
  const theme = resolveBrandTheme(req, payload || {})
  if (!theme) return { skipped: 'no-brand-match' }

  if (!to || !String(to).includes('@')) return { skipped: 'no-recipient', brand: theme.key }

  const result = await sendBrandedEmail({
    theme,
    to,
    // Conversational subject avoids classic promo triggers ("free", "giveaway", "win")
    subject: 'Got your entry',
    html: renderGiveawayEntryEmailHtml(theme, { productName, unsubscribeUrl }),
    text: renderGiveawayEntryEmailText(theme, { productName, unsubscribeUrl }),
    headers: benchUnsubscribeHeaders(theme, unsubscribeUrl),
  })
  return { ...result, brand: theme.key }
}

export { BRAND_THEMES, DEFAULT_THEME, resolveBrandTheme, resolveTurboSmtpAccount, describeEmailTransports, renderOrderEmailHtml, renderPasswordResetEmailHtml, renderPasswordResetEmailText, renderBenchWaitlistEmailHtml, renderBenchWaitlistEmailText, renderUnsubscribePageHtml, benchUnsubscribeHeaders }
