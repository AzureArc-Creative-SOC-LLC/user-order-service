// order-emails.js
// Per-brand, theme-matched order-confirmation emails sent via Resend.
//
// The user-order-service is shared by several white-label storefronts. When a
// browser on one of those storefronts places an order, its cross-origin request
// carries an `Origin` header (e.g. https://luxenlabs.shop). We use that to pick
// the matching brand theme and render a confirmation email that looks like that
// specific site — instead of the generic Alluvi template.
//
// Security: the Resend API key is read from process.env.RESEND_API_KEY (never
// hard-coded / committed). The sending domain in ORDER_EMAIL_FROM must be
// verified in the Resend account tied to that key, or delivery will fail.

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

// ── Per-brand themes (extracted from each site's design tokens) ──────────────
// Keyed by bare domain (no www). Each storefront is matched by its Origin host.
const BRAND_THEMES = {
  'luxenlabs.shop': {
    key: 'luxen', brand: 'LUXEN', domain: 'luxenlabs.shop',
    tagline: 'Advancing lab research', currency: '£',
    bg: '#ffffff', surface: '#eff8fd', heading: '#010101', body: '#010101',
    muted: '#6e7276', accent: '#0083c3', accentText: '#ffffff', border: '#e6e6e6',
    fontHeading: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    fontBody: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  },
  'peptiqlabs.io': {
    key: 'peptiq', brand: 'Peptiq', domain: 'peptiqlabs.io',
    tagline: 'Engineered for research precision', currency: '£',
    bg: '#ffffff', surface: '#f5f8fa', heading: '#0a0b0d', body: '#0a0b0d',
    muted: '#5b6670', accent: '#1863dc', accentText: '#ffffff', border: '#e3e9ee',
    fontHeading: "'Hanken Grotesk', 'Helvetica Neue', Arial, sans-serif",
    fontBody: "'Hanken Grotesk', 'Helvetica Neue', Arial, sans-serif",
  },
  'zyrahealthcare.com': {
    key: 'zyra', brand: 'Zyra Labs', domain: 'zyrahealthcare.com',
    tagline: 'Research-grade peptides, held to a higher standard.', currency: '$',
    bg: '#faf8f4', surface: '#ffffff', heading: '#0e0e0e', body: '#1a1a1a',
    muted: '#6c6c6c', accent: '#e5462b', accentText: '#f4f2ec', border: '#e6e1d8',
    fontHeading: "Georgia, 'Times New Roman', Times, serif",
    fontBody: "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  },
  'vyralabs.co': {
    key: 'vyra', brand: 'Vyra Health', domain: 'vyralabs.co',
    tagline: 'Weight loss, reviewed by clinicians', currency: '$',
    bg: '#ffffff', surface: '#ffffff', heading: '#181d4e', body: '#6b7076',
    muted: '#9aa0a6', accent: '#f4866e', accentText: '#ffffff', border: '#f0e1dd',
    fontHeading: "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif",
    fontBody: "'Red Hat Text', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  'lumivexlabs.co': {
    key: 'lumivex', brand: 'Lumivex', domain: 'lumivexlabs.co',
    tagline: 'High-purity research compounds, precisely made.', currency: '£',
    bg: '#f6f2eb', surface: '#efe9de', heading: '#1c1a17', body: '#2a2722',
    muted: '#a9987f', accent: '#b8965a', accentText: '#f6f2eb', border: '#e3d9c7',
    fontHeading: "'General Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif",
    fontBody: "'General Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  },
  'noverafitness.com': {
    key: 'novera', brand: 'Novera', domain: 'noverafitness.com',
    tagline: 'Research-grade peptides & wellness science', currency: '$',
    bg: '#fffefd', surface: '#fbf8f5', heading: '#1a1a1a', body: '#1a1a1a',
    muted: '#6d6d6d', accent: '#536052', accentText: '#f8f4ef', border: '#e6ddd3',
    fontHeading: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
    fontBody: "Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
  },
  'jupyterlabs.net': {
    key: 'jupyterlabs', brand: 'Jupyter Labs', domain: 'jupyterlabs.net',
    tagline: 'Pharmaceutical rigor, in every vial.', currency: '£',
    bg: '#ffffff', surface: '#eef5f4', heading: '#14202a', body: '#14202a',
    muted: '#5f6c6c', accent: '#14b8a6', accentText: '#ffffff', border: '#e1e9e8',
    fontHeading: "'Space Grotesk', Arial, sans-serif",
    fontBody: "'Space Grotesk', Arial, sans-serif",
  },
  'vorahealthcare.com': {
    key: 'vora', brand: 'Vora', domain: 'vorahealthcare.com',
    tagline: 'Premium research peptides for laboratory R&D', currency: '£',
    bg: '#fffbf3', surface: '#f3f0eb', heading: '#043460', body: '#043460',
    muted: '#3d6081', accent: '#e1fcad', accentText: '#043460', border: '#e9e4db',
    fontHeading: "'Playfair Display', Georgia, 'Times New Roman', serif",
    fontBody: "'Inter Tight', system-ui, sans-serif",
  },
  'liorahealthcare.com': {
    key: 'liora', brand: 'Liora Healthcare', domain: 'liorahealthcare.com',
    tagline: 'Research-grade peptide supply', currency: 'AED ',
    bg: '#080808', surface: '#141414', heading: '#ffffff', body: '#ffffff',
    muted: '#949490', accent: '#ffeec8', accentText: '#080808', border: '#4b4b49',
    fontHeading: "'Anton', 'Bebas Neue', Impact, sans-serif",
    fontBody: "'IBM Plex Sans', system-ui, 'Segoe UI', Roboto, sans-serif",
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
  tagline: 'Premium Research Peptides', currency: '£',
  bg: '#ffffff', surface: '#f7f7f8', heading: '#0a0a0a', body: '#0a0a0a',
  muted: '#6b7280', accent: '#00b894', accentText: '#ffffff', border: '#e5e7eb',
  fontHeading: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  fontBody: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
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

async function sendViaResend({ apiKey, from, to, replyTo, subject, html, text }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
      signal: controller.signal,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { success: false, error: data?.message || data?.error || `Resend ${res.status}` }
    return { success: true, messageId: data?.id || null }
  } catch (e) {
    return { success: false, error: e?.name === 'AbortError' ? 'Resend timeout' : (e?.message || String(e)) }
  } finally {
    clearTimeout(timer)
  }
}

// Main entry: send a brand-themed order confirmation.
// Returns { skipped } when no storefront matches (caller should fall back to the
// generic email) or when Resend isn't configured. Returns { success } on send.
export async function sendBrandedOrderConfirmation({ req, to, payload, orderNumber, customerName }) {
  const theme = resolveBrandTheme(req, payload || {})
  if (!theme) return { skipped: 'no-brand-match' }

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return { skipped: 'no-resend-key', brand: theme.key }
  if (!to || !String(to).includes('@')) return { skipped: 'no-recipient', brand: theme.key }

  const order = orderViewFromPayload(payload || {}, String(orderNumber || '').trim(), customerName)
  const fromEmail = process.env.ORDER_EMAIL_FROM || process.env.EMAIL_FROM_EMAIL || 'orders@alluvi.org'
  const from = `${theme.brand} <${fromEmail}>`
  const subject = `Your ${theme.brand} order ${order.orderNumber} is confirmed`

  const result = await sendViaResend({
    apiKey,
    from,
    to,
    replyTo: fromEmail,
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
// from the request Origin/Referer (falling back to the generic Alluvi theme so
// nothing ever falls back to a bespoke, unbranded design), and sends from that
// storefront's own domain (orders@<domain>) so the "From" address matches the
// site the user actually signed up on.
// Returns { skipped } when Resend isn't configured (caller should fall back to
// a direct-SMTP send). Returns { success } on send.
export async function sendBrandedPasswordResetEmail({ req, to, resetLink, userName }) {
  const theme = resolveBrandTheme(req, {}) || DEFAULT_THEME

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return { skipped: 'no-resend-key', brand: theme.key, theme }
  if (!to || !String(to).includes('@')) return { skipped: 'no-recipient', brand: theme.key, theme }

  const fromEmail = `orders@${theme.domain}`
  const from = `${theme.brand} <${fromEmail}>`
  const subject = `Reset Your ${theme.brand} Password`
  const view = { userName: userName || 'there', resetLink }

  const result = await sendViaResend({
    apiKey,
    from,
    to,
    replyTo: fromEmail,
    subject,
    html: renderPasswordResetEmailHtml(theme, view),
    text: renderPasswordResetEmailText(theme, view),
  })
  return { ...result, brand: theme.key, theme }
}

export { BRAND_THEMES, DEFAULT_THEME, resolveBrandTheme, renderOrderEmailHtml, renderPasswordResetEmailHtml, renderPasswordResetEmailText }
