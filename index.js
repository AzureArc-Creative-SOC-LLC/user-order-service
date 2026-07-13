import express from 'express';
import cors from 'cors';
import mysql from './db-adapter.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { fengyuProxy } from './fengyu-proxy.js';

import { fileURLToPath } from 'url'

import { buildHasInvoiceMaskedItems, sendAffiliateRewardNotificationEmail, sendAffiliateWelcomeEmail, sendDeliveryInformationEmail, sendEmail, sendHasInvoiceEmail, sendKlymePaymentRejectedEmail, sendKlymePaymentSuccessfulEmail, sendNewsletterEntryEmail, sendOrderConfirmationEmail, sendPaymentDeclinedEmail, sendPaymentReminderEmail, sendPaymentScreenshotReceivedEmail, sendPaymentSuccessfulEmail, sendStatusUpdateEmail } from './emailService.js'
import { sendBrandedOrderConfirmation, sendBrandedPasswordResetEmail, resolveBrandTheme, renderPasswordResetEmailHtml, DEFAULT_THEME } from './order-emails.js'



const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const dotenvCandidates = [
  process.env.DOTENV_PATH,
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', '..', '.env'),
  path.resolve(__dirname, '..', '..', '..', '.env'),
].filter(Boolean)



let loadedDotenvPath = ''

for (const p of dotenvCandidates) {
  if (!p) continue
  try {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p, override: true })
      loadedDotenvPath = String(p)
      break
    }

  } catch (e) {
    console.error(`Failed to load dotenv from ${p}: ${e.message}`)
  }

}

if (!loadedDotenvPath) {
  console.error('No dotenv file found')
}



async function ensureTestProduct32Exists(connection) {
  try {
    // Minimal row to satisfy FK: products.id is referenced by order_items.product_id.
    // Keep slug/sku unique and stable.
    await connection.execute(
      `INSERT INTO products (
        id, name, slug, sku, price, currency, in_stock,
        image_url, image_alt, short_desc, long_desc,
        is_enabled, display_order, klyme_enabled, created_at, updated_at
      ) VALUES (
        32, 'Test Product (Dummy)', 'test-product-32', 'TEST-GBP1-32', 1.00, 'GBP', TRUE,
        NULL, 'Test Product', 'Sandbox payment testing', 'This is a dummy product used only for sandbox testing. Price is £1 GBP.',
        FALSE, 0, FALSE, NOW(), NOW()
      )
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        updated_at = NOW()`,
      []
    )
  } catch (e) {
    console.error('[ensureTestProduct32Exists] failed', e?.message || String(e))
  }
}



async function reserveAvailableCreditsForOrder(connection, orderNumber, opts) {
  const now = nowMysqlDatetime()
  const source = String(opts?.source || 'order_reserve').trim() || 'order_reserve'
  const allowUpdatePaymentAmount = !!opts?.allowUpdatePaymentAmount

  try {
    await ensureCustomerCreditsSchema()
  } catch {
    // ignore
  }

  const [orderRows] = await connection.execute(
    'SELECT id, order_number, customer_email, total, credits_applied, credits_reserved FROM orders WHERE order_number = ? LIMIT 1',
    [orderNumber]
  )
  const order = Array.isArray(orderRows) && orderRows[0] ? orderRows[0] : null
  if (!order?.id) return { ok: false, reason: 'order_not_found' }

  const alreadyApplied = Number(order?.credits_applied || 0)
  if (Number.isFinite(alreadyApplied) && alreadyApplied > 0) {
    return { ok: true, orderId: order.id, orderNumber: order.order_number, creditsReserved: 0, alreadyApplied: true }
  }

  const alreadyReserved = Number(order?.credits_reserved || 0)
  if (Number.isFinite(alreadyReserved) && alreadyReserved > 0) {
    const safeTotal = Number.isFinite(Number(order?.total)) ? Number(order.total) : 0
    const payableTotal = Number((safeTotal - alreadyReserved).toFixed(2))
    if (allowUpdatePaymentAmount) {
      try {
        await connection.execute('UPDATE payments SET amount = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?', [payableTotal, order.id])
      } catch {
        // ignore
      }
    }
    return { ok: true, orderId: order.id, orderNumber: order.order_number, creditsReserved: alreadyReserved, payableTotal, alreadyReserved: true }
  }

  const email = String(order?.customer_email || '').trim().toLowerCase()
  if (!email || !email.includes('@')) return { ok: false, reason: 'missing_email' }

  try {
    const [userRows] = await connection.execute('SELECT id FROM users WHERE email = ? LIMIT 1', [email])
    const userId = Array.isArray(userRows) && userRows[0] ? userRows[0].id : null
    if (!userId) return { ok: false, reason: 'user_not_found' }

    await connection.execute('INSERT IGNORE INTO user_credits (user_id, balance) VALUES (?, 0.00)', [userId])
    const [creditRows] = await connection.execute('SELECT balance FROM user_credits WHERE user_id = ? LIMIT 1', [userId])
    const creditList = Array.isArray(creditRows) ? creditRows : []
    const balance = creditList.length ? Number((creditList[0]?.balance ?? 0) || 0) : 0
    const safeBalance = Number.isFinite(balance) ? balance : 0

    const safeTotal = Number.isFinite(Number(order?.total)) ? Number(order.total) : 0
    let creditsReserved = Math.max(0, Math.min(safeBalance, safeTotal))
    creditsReserved = Number(creditsReserved.toFixed(2))

    if (!(creditsReserved > 0)) {
      return { ok: true, orderId: order.id, orderNumber: order.order_number, creditsReserved: 0, alreadyReserved: false }
    }

    const payableTotal = Number((safeTotal - creditsReserved).toFixed(2))

    await connection.execute(
      'UPDATE orders SET credits_reserved = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? LIMIT 1',
      [creditsReserved, order.id]
    )

    if (allowUpdatePaymentAmount) {
      try {
        await connection.execute(
          'UPDATE payments SET amount = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?',
          [payableTotal, order.id]
        )
      } catch {
        // ignore
      }
    }

    try {
      await connection.execute(
        'INSERT INTO credit_ledger (user_id, amount, source, order_number, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, 0, source, String(order.order_number || orderNumber), `reserved ${creditsReserved.toFixed(2)}`, now]
      )
    } catch {
      // ignore
    }

    return {
      ok: true,
      orderId: order.id,
      orderNumber: order.order_number,
      creditsReserved,
      payableTotal,
      alreadyReserved: false,
    }
  } catch (e) {
    return { ok: false, reason: 'reserve_failed', error: e?.message || String(e) }
  }
}



async function ensureAffiliateSchema() {
  const isDuplicate = (err) => {
    const msg = String(err?.message || '').toLowerCase()
    return msg.includes('duplicate') || msg.includes('exists')
  }

  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(64) NOT NULL,
        percent INT NOT NULL DEFAULT 0,
        source VARCHAR(32) NOT NULL DEFAULT 'manual',
        user_id INT NULL,
        is_active TINYINT NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_promo_codes_code (code),
        INDEX idx_promo_codes_user (user_id),
        INDEX idx_promo_codes_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure promo_codes table:', msg)
    }
  }

  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS affiliate_requests (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        user_email VARCHAR(255) NOT NULL,
        user_name VARCHAR(255) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        promo_code VARCHAR(64) NULL,
        promo_percent INT NULL,
        admin_id INT NULL,
        admin_note VARCHAR(255) NULL,
        decided_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_affiliate_requests_status (status),
        INDEX idx_affiliate_requests_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure affiliate_requests table:', msg)
    }
  }

  try {
    await pool.execute('ALTER TABLE affiliate_requests ADD UNIQUE KEY uq_affiliate_requests_user (user_id)')
  } catch (e) {
    if (!isDuplicate(e)) console.error('Failed to ensure affiliate_requests unique user constraint:', e?.message || String(e))
  }

  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS affiliates (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        promo_code VARCHAR(64) NULL,
        promo_percent INT NOT NULL DEFAULT 10,
        reward_amount DECIMAL(12,2) NOT NULL DEFAULT 10.00,
        status VARCHAR(16) NOT NULL DEFAULT 'approved',
        approved_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_affiliates_user (user_id),
        INDEX idx_affiliates_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure affiliates table:', msg)
    }
  }

  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS promo_redemptions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        order_number VARCHAR(64) NOT NULL,
        promo_code VARCHAR(64) NOT NULL,
        affiliate_user_id INT NOT NULL,
        customer_email VARCHAR(255) NOT NULL,
        reward_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        status VARCHAR(16) NOT NULL DEFAULT 'granted',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_promo_redemptions_order (order_id),
        UNIQUE KEY uq_promo_redemptions_affiliate_customer (affiliate_user_id, customer_email),
        INDEX idx_promo_redemptions_affiliate (affiliate_user_id),
        INDEX idx_promo_redemptions_code (promo_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure promo_redemptions table:', msg)
    }
  }

  try {
    await pool.execute('ALTER TABLE promo_redemptions ADD COLUMN customer_email VARCHAR(255) NOT NULL')
  } catch (e) {
    if (!isDuplicate(e)) console.error('Failed to ensure promo_redemptions.customer_email:', e?.message || String(e))
  }
  try {
    await pool.execute('ALTER TABLE promo_redemptions ADD UNIQUE KEY uq_promo_redemptions_affiliate_customer (affiliate_user_id, customer_email)')
  } catch (e) {
    if (!isDuplicate(e)) console.error('Failed to ensure promo_redemptions affiliate/customer unique:', e?.message || String(e))
  }

  // Self-serve affiliate signup fields (idempotent on rerun).
  for (const sql of [
    'ALTER TABLE affiliate_requests ADD COLUMN first_name VARCHAR(64) NULL',
    'ALTER TABLE affiliate_requests ADD COLUMN last_name VARCHAR(64) NULL',
    'ALTER TABLE affiliate_requests ADD COLUMN tiktok_link VARCHAR(255) NULL',
    'ALTER TABLE affiliates ADD COLUMN first_name VARCHAR(64) NULL',
    'ALTER TABLE affiliates ADD COLUMN last_name VARCHAR(64) NULL',
    'ALTER TABLE affiliates ADD COLUMN tiktok_link VARCHAR(255) NULL',
  ]) {
    try {
      await pool.execute(sql)
    } catch (e) {
      if (!isDuplicate(e)) console.error(`Failed schema migration "${sql}":`, e?.message || String(e))
    }
  }
}



const STATIC_PROMO_MAP = {
  SAVE10: 10,
  PETER10: 10,
  DAVID10: 10,
}

async function resolvePromoPercent(connection, codeRaw) {
  const code = String(codeRaw || '').trim().toUpperCase()
  if (!code) return 0

  const staticPercent = Number(STATIC_PROMO_MAP[code] || 0)
  if (Number.isFinite(staticPercent) && staticPercent > 0) return staticPercent

  try {
    await ensureAffiliateSchema()
  } catch {
    // ignore
  }

  try {
    const [rows] = await connection.execute(
      `SELECT percent
       FROM promo_codes
       WHERE code = ? AND is_active = 1
       ORDER BY id DESC
       LIMIT 1`,
      [code]
    )
    const r = Array.isArray(rows) && rows[0] ? rows[0] : null
    const percent = Number(r?.percent || 0)
    if (Number.isFinite(percent) && percent > 0) return percent
  } catch {
    // ignore
  }

  return 0
}



async function grantAffiliateRewardForOrder(connection, orderNumber, opts) {
  const rewardAmount = Number(opts?.rewardAmount ?? 40)
  const safeReward = Number.isFinite(rewardAmount) && rewardAmount > 0 ? Number(rewardAmount.toFixed(2)) : 40
  const tag = `[affiliate-grant ${orderNumber}]`

  try {
    await ensureAffiliateSchema()
  } catch {
    // ignore
  }
  try {
    await ensureCustomerCreditsSchema()
  } catch {
    // ignore
  }

  const [orderRows] = await connection.execute(
    'SELECT id, order_number, customer_email, promo_code, payment_status FROM orders WHERE order_number = ? LIMIT 1',
    [orderNumber]
  )
  const order = Array.isArray(orderRows) && orderRows[0] ? orderRows[0] : null
  if (!order?.id) {
    console.log(`${tag} skip: order_not_found`)
    return { ok: false, reason: 'order_not_found' }
  }

  const customerEmail = String(order?.customer_email || '').trim().toLowerCase()
  if (!customerEmail || !customerEmail.includes('@')) {
    console.log(`${tag} skip: missing_customer_email`)
    return { ok: true, skipped: true, reason: 'missing_customer_email' }
  }

  const paymentStatus = String(order?.payment_status || '').trim().toLowerCase()
  if (paymentStatus !== 'received') {
    console.log(`${tag} skip: not_paid (payment_status=${paymentStatus})`)
    return { ok: true, skipped: true, reason: 'not_paid' }
  }

  const promoCode = String(order?.promo_code || '').trim().toUpperCase()
  if (!promoCode || promoCode === '-' || promoCode === 'NONE') {
    console.log(`${tag} skip: no_promo (promo_code=${order?.promo_code || 'null'})`)
    return { ok: true, skipped: true, reason: 'no_promo' }
  }

  const [promoRows] = await connection.execute(
    `SELECT user_id
     FROM promo_codes
     WHERE code = ? AND is_active = 1 AND LOWER(source) = 'affiliate'
     ORDER BY id DESC
     LIMIT 1`,
    [promoCode]
  )
  const promo = Array.isArray(promoRows) && promoRows[0] ? promoRows[0] : null
  const affiliateUserId = Number(promo?.user_id)
  if (!Number.isFinite(affiliateUserId) || affiliateUserId <= 0) {
    console.log(`${tag} skip: not_affiliate_code (promo=${promoCode})`)
    return { ok: true, skipped: true, reason: 'not_affiliate_code' }
  }

  // Prevent self-referrals (same email as affiliate user).
  try {
    if (customerEmail && customerEmail.includes('@')) {
      const [uRows] = await connection.execute('SELECT id FROM users WHERE LOWER(TRIM(email)) = ? LIMIT 1', [customerEmail])
      const buyerUserId = Number(Array.isArray(uRows) && uRows[0] ? uRows[0].id : NaN)
      if (Number.isFinite(buyerUserId) && buyerUserId > 0 && buyerUserId === affiliateUserId) {
        console.log(`${tag} skip: self_referral (affiliate=${affiliateUserId}, buyer=${buyerUserId})`)
        return { ok: true, skipped: true, reason: 'self_referral' }
      }
    }
  } catch {
    // ignore
  }

  // Anti-abuse: only reward once per affiliate per unique customer email.
  const [existingByCustomer] = await connection.execute(
    'SELECT id FROM promo_redemptions WHERE affiliate_user_id = ? AND customer_email = ? LIMIT 1 FOR UPDATE',
    [affiliateUserId, customerEmail]
  )
  const customerHit = Array.isArray(existingByCustomer) && existingByCustomer[0] ? existingByCustomer[0] : null
  if (customerHit?.id) {
    console.log(`${tag} skip: customer_already_rewarded (affiliate=${affiliateUserId}, customer=${customerEmail})`)
    return { ok: true, skipped: true, reason: 'customer_already_rewarded' }
  }

  const [existingRows] = await connection.execute(
    'SELECT id FROM promo_redemptions WHERE order_id = ? LIMIT 1 FOR UPDATE',
    [order.id]
  )
  const existing = Array.isArray(existingRows) && existingRows[0] ? existingRows[0] : null
  if (existing?.id) {
    console.log(`${tag} skip: already_granted (order_id=${order.id})`)
    return { ok: true, alreadyGranted: true }
  }

  // Ensure wallet row exists.
  await connection.execute('INSERT IGNORE INTO user_credits (user_id, balance) VALUES (?, 0.00)', [affiliateUserId])

  await connection.execute(
    'UPDATE user_credits SET balance = COALESCE(balance, 0) + ? WHERE user_id = ? LIMIT 1',
    [safeReward, affiliateUserId]
  )

  await connection.execute(
    'INSERT INTO credit_ledger (user_id, amount, source, order_number, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      affiliateUserId,
      safeReward,
      'affiliate_reward',
      String(order.order_number || orderNumber),
      `promo ${promoCode} redeemed`,
      nowMysqlDatetime(),
    ]
  )

  await connection.execute(
    'INSERT INTO promo_redemptions (order_id, order_number, promo_code, affiliate_user_id, customer_email, reward_amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      Number(order.id),
      String(order.order_number || orderNumber),
      promoCode,
      affiliateUserId,
      customerEmail,
      safeReward,
      'granted',
      nowMysqlDatetime(),
    ]
  )

  // Fire-and-forget redemption notification to the affiliate.
  // Email failures must never roll back the credit grant or block the caller.
  try {
    const [notifyRows] = await connection.execute(
      `SELECT u.email AS email, a.first_name AS first_name, c.balance AS balance
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN user_credits c ON c.user_id = a.user_id
       WHERE a.user_id = ?
       LIMIT 1`,
      [affiliateUserId]
    )
    const notify = Array.isArray(notifyRows) && notifyRows[0] ? notifyRows[0] : null
    const notifyEmail = String(notify?.email || '').trim()
    if (notifyEmail && notifyEmail.includes('@')) {
      const newBalanceNum = Number(notify?.balance)
      const payload = {
        firstName: String(notify?.first_name || '').trim(),
        promoCode,
        rewardAmount: safeReward,
        newBalance: Number.isFinite(newBalanceNum) ? newBalanceNum : null,
      }
      void sendAffiliateRewardNotificationEmail(notifyEmail, payload).catch((err) => {
        console.error('Failed to send affiliate redemption email:', err?.message || String(err))
      })
    }
  } catch (err) {
    console.error('Failed to dispatch affiliate redemption email:', err?.message || String(err))
  }

  console.log(`${tag} GRANTED £${safeReward.toFixed(2)} to affiliate user_id=${affiliateUserId} (promo=${promoCode}, customer=${customerEmail})`)
  return { ok: true, granted: true, affiliateUserId, promoCode, rewardAmount: safeReward }
}

// Convenience wrapper: looks up order_number from order_id, then grants the affiliate reward.
// Idempotent — safe to call from every payment-success path.
async function grantAffiliateRewardForOrderId(connection, orderId, opts) {
  try {
    const numericId = Number(orderId)
    if (!Number.isFinite(numericId) || numericId <= 0) return { ok: false, reason: 'invalid_order_id' }
    const [rows] = await connection.execute('SELECT order_number FROM orders WHERE id = ? LIMIT 1', [numericId])
    const orderNumber = Array.isArray(rows) && rows[0] ? String(rows[0].order_number || '').trim() : ''
    if (!orderNumber) return { ok: false, reason: 'order_not_found' }
    return await grantAffiliateRewardForOrder(connection, orderNumber, opts)
  } catch (e) {
    return { ok: false, reason: 'error', error: e?.message || String(e) }
  }
}



async function finalizeReservedCreditsForOrder(connection, orderNumber, opts) {
  const now = nowMysqlDatetime()
  const source = String(opts?.source || 'order_apply').trim() || 'order_apply'

  try {
    await ensureCustomerCreditsSchema()
  } catch {
    // ignore
  }

  const [orderRows] = await connection.execute(
    'SELECT id, order_number, customer_email, total, credits_applied, credits_reserved, total_before_credits FROM orders WHERE order_number = ? LIMIT 1',
    [orderNumber]
  )
  const order = Array.isArray(orderRows) && orderRows[0] ? orderRows[0] : null
  if (!order?.id) return { ok: false, reason: 'order_not_found' }

  const alreadyApplied = Number(order?.credits_applied || 0)
  if (Number.isFinite(alreadyApplied) && alreadyApplied > 0) {
    return { ok: true, orderId: order.id, orderNumber: order.order_number, creditsApplied: alreadyApplied, alreadyApplied: true }
  }

  const reserved = Number(order?.credits_reserved || 0)
  if (!Number.isFinite(reserved) || reserved <= 0) {
    return { ok: true, orderId: order.id, orderNumber: order.order_number, creditsApplied: 0, alreadyApplied: false, noReservation: true }
  }

  const email = String(order?.customer_email || '').trim().toLowerCase()
  if (!email || !email.includes('@')) return { ok: false, reason: 'missing_email' }

  const [userRows] = await connection.execute('SELECT id FROM users WHERE email = ? LIMIT 1', [email])
  const userId = Array.isArray(userRows) && userRows[0] ? userRows[0].id : null
  if (!userId) return { ok: false, reason: 'user_not_found' }

  await connection.execute('INSERT IGNORE INTO user_credits (user_id, balance) VALUES (?, 0.00)', [userId])
  const [creditRows] = await connection.execute('SELECT balance FROM user_credits WHERE user_id = ? FOR UPDATE', [userId])
  const creditList = Array.isArray(creditRows) ? creditRows : []
  const balance = creditList.length ? Number((creditList[0]?.balance ?? 0) || 0) : 0
  const safeBalance = Number.isFinite(balance) ? balance : 0

  const safeTotal = Number.isFinite(Number(order?.total)) ? Number(order.total) : 0
  let creditsApplied = Math.max(0, Math.min(safeBalance, reserved, safeTotal))
  creditsApplied = Number(creditsApplied.toFixed(2))

  if (!(creditsApplied > 0)) {
    await connection.execute('UPDATE orders SET credits_reserved = 0.00, updated_at = CURRENT_TIMESTAMP WHERE id = ? LIMIT 1', [order.id])
    return { ok: true, orderId: order.id, orderNumber: order.order_number, creditsApplied: 0, alreadyApplied: false }
  }

  const totalBeforeCredits = Number.isFinite(Number(order?.total_before_credits)) && Number(order.total_before_credits) > 0
    ? Number(order.total_before_credits)
    : safeTotal
  const payableTotal = Number((totalBeforeCredits - creditsApplied).toFixed(2))

  await connection.execute(
    'UPDATE user_credits SET balance = COALESCE(balance, 0) - ? WHERE user_id = ? LIMIT 1',
    [creditsApplied, userId]
  )

  await connection.execute(
    'INSERT INTO credit_ledger (user_id, amount, source, order_number, created_at) VALUES (?, ?, ?, ?, ?)',
    [userId, -creditsApplied, source, String(order.order_number || orderNumber), now]
  )

  await connection.execute(
    'UPDATE orders SET credits_applied = ?, total_before_credits = ?, total = ?, credits_reserved = 0.00, updated_at = CURRENT_TIMESTAMP WHERE id = ? LIMIT 1',
    [creditsApplied, totalBeforeCredits, payableTotal, order.id]
  )

  return {
    ok: true,
    orderId: order.id,
    orderNumber: order.order_number,
    creditsApplied,
    payableTotal,
    alreadyApplied: false,
  }
}



async function ensureCustomerCreditsSchema() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS user_credits (
        user_id INT NOT NULL,
        balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id),
        CONSTRAINT fk_user_credits_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure user_credits table:', msg)
    }
  }

  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        source VARCHAR(50) NOT NULL,
        order_number VARCHAR(64) NULL,
        admin_username VARCHAR(64) NULL,
        note VARCHAR(255) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_credit_ledger_user (user_id),
        INDEX idx_credit_ledger_created (created_at),
        CONSTRAINT fk_credit_ledger_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure credit_ledger table:', msg)
    }
  }

  const isDuplicate = (err) => {
    const msg = String(err?.message || '').toLowerCase()
    return msg.includes('duplicate') || msg.includes('exists')
  }
  try {
    await pool.execute('ALTER TABLE orders ADD COLUMN credits_applied DECIMAL(12,2) NOT NULL DEFAULT 0.00')
  } catch (e) {
    if (!isDuplicate(e)) console.error('Failed to ensure orders.credits_applied:', e?.message || String(e))
  }
  try {
    await pool.execute('ALTER TABLE orders ADD COLUMN total_before_credits DECIMAL(12,2) NULL')
  } catch (e) {
    if (!isDuplicate(e)) console.error('Failed to ensure orders.total_before_credits:', e?.message || String(e))
  }
  try {
    await pool.execute('ALTER TABLE orders ADD COLUMN credits_reserved DECIMAL(12,2) NOT NULL DEFAULT 0.00')
  } catch (e) {
    if (!isDuplicate(e)) console.error('Failed to ensure orders.credits_reserved:', e?.message || String(e))
  }
}

function isBundleItemIdentifier(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return false
  if (s.includes('bundle-retatrutide')) return true
  if (s.startsWith('bundled-')) return true
  if (s.includes('bundled')) return true
  return false
}

function orderItemsContainBundle(items) {
  const list = Array.isArray(items) ? items : []
  return list.some((it) => {
    const sku = it?.sku ?? it?.product_sku
    const name = it?.name ?? it?.product_name
    const pid = it?.productId ?? it?.product_id ?? it?.id
    return isBundleItemIdentifier(sku) || isBundleItemIdentifier(name) || isBundleItemIdentifier(pid)
  })
}

console.log('[user-order-creation] dotenv loaded', {
  loadedDotenvPath: loadedDotenvPath || null,
  cwd: process.cwd(),
})


function withTimeout(promise, ms, label) {

  const timeoutMs = Number(ms)

  const safeMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000

  let t

  const timeoutPromise = new Promise((_, reject) => {

    t = setTimeout(() => {

      const err = new Error(`${label || 'operation'} timed out after ${safeMs}ms`)

      err.code = 'ETIMEDOUT'

      reject(err)

    }, safeMs)

  })


  return Promise.race([promise, timeoutPromise]).finally(() => {

    clearTimeout(t)

  })

}

const maskSecret = (value) => {
  const s = String(value || '').trim()
  if (!s) return ''
  if (s.length <= 10) return `${s.slice(0, 2)}***${s.slice(-2)}`
  return `${s.slice(0, 6)}***${s.slice(-4)}`
}

try {
  const envName = String(process.env.KLYME_ENV || 'production').trim().toLowerCase()
  const merchantUuid = envName === 'sandbox' || envName === 'test'
    ? String(process.env.KLYME_SANDBOX_MERCHANT_UUID || '').trim()
    : String(process.env.KLYME_MERCHANT_UUID || '').trim()

  console.log('[user-order-creation] klyme env snapshot', {
    envName,
    merchantUuidMasked: merchantUuid ? maskSecret(merchantUuid) : null,
  })
} catch (e) {
  console.warn('[user-order-creation] failed to log klyme env snapshot')
}



function isKlymeCheckoutPayload(payload, opts) {

  const provider = String(opts?.providerId || '').trim().toLowerCase()

  const method = String(payload?.payment_method || payload?.paymentMethod || payload?.provider || payload?.payment_provider || '').trim().toLowerCase()

  const mode = String(payload?.mode || payload?.checkoutMode || '').trim().toLowerCase()

  const hint = String(payload?.klyme || payload?.klyme_enabled || payload?.klymeEnabled || '').trim().toLowerCase()

  const uuid = String(payload?.paymentUuid || payload?.payment_uuid || payload?.klymePaymentUuid || '').trim()



  return (

    provider.startsWith('klyme') ||

    method === 'klyme' ||

    mode === 'klyme' ||

    hint === 'true' ||

    hint === '1' ||

    !!uuid

  )

}



function addBusinessDays(date, days) {

  const d = new Date(date)

  if (Number.isNaN(d.getTime())) return null

  let remaining = Math.max(0, Number(days || 0))

  while (remaining > 0) {

    d.setDate(d.getDate() + 1)

    const wd = d.getDay() // 0 Sun, 6 Sat

    if (wd !== 0 && wd !== 6) remaining -= 1

  }

  return d

}



function computeUkDeliveryEstimate(paymentDate) {

  const d = paymentDate instanceof Date ? paymentDate : new Date(paymentDate)

  if (Number.isNaN(d.getTime())) {

    return { deliveryText: 'If you paid before 2pm UK time then delivery is tomorrow. If you paid after 2pm then delivery is the day after tomorrow.', deliveryDateLabel: '' }

  }



  const parts = new Intl.DateTimeFormat('en-GB', {

    timeZone: 'Europe/London',

    year: 'numeric',

    month: '2-digit',

    day: '2-digit',

    hour12: false,

    hour: '2-digit',

    minute: '2-digit',

  }).formatToParts(d)



  const getPart = (type) => {

    const p = parts.find((x) => x.type === type)

    return p ? String(p.value) : ''

  }



  const year = Number(getPart('year'))

  const month = Number(getPart('month'))

  const day = Number(getPart('day'))

  const hour = Number(getPart('hour'))

  const minute = Number(getPart('minute'))



  // Determine cutoff at 14:00 Europe/London.

  const minutesOfDay = (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0)

  const beforeCutoff = minutesOfDay < (14 * 60)



  // Compute expected delivery date based on the *UK-local calendar date*.

  // Use UTC date arithmetic at noon to avoid DST/timezone off-by-one issues.

  const baseUtcNoon = Date.UTC(

    Number.isFinite(year) ? year : d.getUTCFullYear(),

    Number.isFinite(month) ? month - 1 : d.getUTCMonth(),

    Number.isFinite(day) ? day : d.getUTCDate(),

    12,

    0,

    0

  )



  const addUkBusinessDays = (utcNoonMs, n) => {

    let ms = utcNoonMs

    let remaining = Math.max(0, Number(n || 0))

    while (remaining > 0) {

      ms += 24 * 60 * 60 * 1000

      const wd = new Date(ms).getUTCDay() // 0 Sun, 6 Sat

      if (wd !== 0 && wd !== 6) remaining -= 1

    }

    return new Date(ms)

  }



  const businessDaysToAdd = beforeCutoff ? 1 : 2

  const expected = addUkBusinessDays(baseUtcNoon, businessDaysToAdd)



  const deliveryDateLabel = expected

    ? new Intl.DateTimeFormat('en-GB', {

      timeZone: 'Europe/London',

      weekday: 'long',

      day: '2-digit',

      month: 'short',

      year: 'numeric',

    }).format(expected)

    : ''



  const deliveryText = beforeCutoff

    ? 'Because you paid before 2pm UK time, your delivery is expected tomorrow (next working day).'

    : 'Because you paid after 2pm UK time, your delivery is expected day after tomorrow.'



  return { deliveryText, deliveryDateLabel }

}



async function postExternalInvoice(payload) {

  // Disabled: no outbound requests should be sent to external invoice endpoints.

  return { ok: false, status: 410, data: { error: 'External invoice endpoint disabled' } }

}



function env(name, fallback = '') {

  const v = process.env[name]

  if (v === undefined || v === null || String(v).trim() === '') return fallback

  return String(v)

}



function envInt(name, fallback) {

  const raw = process.env[name]

  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback

  const n = Number(raw)

  return Number.isFinite(n) ? n : fallback

}



const PORT = envInt('USER_ORDER_CREATION_PORT', 5003)



// Prefer DATABASE_URL (Supabase Postgres) when set, since the shared env's
// generic DB_HOST/PORT/USER/PASS/NAME point at the legacy MySQL RDS instance
// used by services not yet migrated to Postgres.
const DATABASE_URL = env('DATABASE_URL', '')

const DB_HOST = env('DB_HOST', 'localhost')

const DB_PORT = envInt('DB_PORT', 3306)

const DB_USER = env('DB_USER', '')

const DB_PASS = env('DB_PASS', '')

const DB_NAME = env('DB_NAME', '')



const JWT_SECRET = env('JWT_SECRET', 'alluvi_super_secret_key_2024_production_secure_token_12345')

const corsOrigin = env('CORS_ORIGIN', '*')



// Klyme Payment Gateway Configuration

const KLYME_ENV = env('KLYME_ENV', 'production')

const KLYME_MERCHANT_UUID = env('KLYME_MERCHANT_UUID', '')

const KLYME_API_USERNAME = env('KLYME_API_USERNAME', '')

const KLYME_API_PASSWORD = env('KLYME_API_PASSWORD', '')

const KLYME_API_BASE_URL = env('KLYME_API_BASE_URL', 'https://api.klyme.io/api/v1')

const KLYME_API_BASE_URLS = env('KLYME_API_BASE_URLS', '')

const KLYME_WEBHOOK_SECRET = env('KLYME_WEBHOOK_SECRET', '')



const KLYME_SANDBOX_MERCHANT_UUID = env('KLYME_SANDBOX_MERCHANT_UUID', '')

const KLYME_SANDBOX_API_USERNAME = env('KLYME_SANDBOX_API_USERNAME', env('KLYME_SANDBOX_API_KEY', ''))

const KLYME_SANDBOX_API_PASSWORD = env('KLYME_SANDBOX_API_PASSWORD', env('KLYME_SANDBOX_SECRET', ''))

const KLYME_SANDBOX_API_BASE_URL = env('KLYME_SANDBOX_API_BASE_URL', 'https://api-test.klyme.io/api/v1')

const KLYME_SANDBOX_API_BASE_URLS = env('KLYME_SANDBOX_API_BASE_URLS', '')



// Password reset email now uses the shared, per-brand light theme in
// order-emails.js (renderPasswordResetEmailHtml) instead of a bespoke dark
// template — see sendBrandedPasswordResetEmail / the /forgot-password route.



const UPLOADS_DIR = env('UPLOADS_DIR', '/var/www/backend/uploads')

const PUBLIC_BASE_URL = env('PUBLIC_BASE_URL', '') // e.g. https://alluvi.store

const PUBLIC_API_BASE_URL = env('PUBLIC_API_BASE_URL', 'https://www.alluvi.store')

const EXTERNAL_INVOICE_URL = env('EXTERNAL_INVOICE_URL', '')



const app = express()

app.set('trust proxy', true)

app.use(express.json({ limit: '5mb' }))

app.use(

  cors({
    // Global CORS: reflect any origin so this API is callable from anywhere in the world.
    origin: true,
    credentials: true,
  })

)

// Handle preflight requests for all routes
app.options('*', cors({ origin: true, credentials: true }))



const pool = mysql.createPool(
  DATABASE_URL
    ? {
      connectionString: DATABASE_URL,
      connectTimeout: envInt('DB_CONNECT_TIMEOUT_MS', 10000),
      waitForConnections: true,
      connectionLimit: 20,
      queueLimit: 100,
      ssl: { rejectUnauthorized: false },
    }
    : {
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASS,
      database: DB_NAME,
      connectTimeout: envInt('DB_CONNECT_TIMEOUT_MS', 10000),
      acquireTimeout: envInt('DB_ACQUIRE_TIMEOUT_MS', 10000),
      timeout: envInt('DB_TIMEOUT_MS', 60000),
      waitForConnections: true,
      connectionLimit: 20,
      queueLimit: 100,
      ssl: { rejectUnauthorized: false },
    }
)

// Add pool event listeners for debugging
pool.on('connection', (connection) => {
  console.log('[DB] New connection established, ID:', connection.threadId)
})

pool.on('enqueue', () => {
  console.log('[DB] Request queued, waiting for available connection')
})

pool.on('error', (err) => {
  console.error('[DB] Pool error:', err)
})


function requireUserAuth(req, res, next) {
  try {
    const header = String(req.headers?.authorization || '')
    const m = header.match(/^Bearer\s+(.+)$/i)
    const rawToken = m ? String(m[1] || '').trim() : ''
    if (!rawToken) return res.status(401).json({ error: 'Missing token' })

    let payload
    try {
      payload = jwt.verify(rawToken, JWT_SECRET)
    } catch {
      return res.status(401).json({ error: 'Invalid token' })
    }

    const userId = Number(payload?.id)
    if (!Number.isFinite(userId) || userId <= 0) return res.status(401).json({ error: 'Invalid token' })

    req.user = {
      id: userId,
      email: String(payload?.email || '').trim(),
      role: String(payload?.role || '').trim(),
    }

    return next()
  } catch (_e) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}


app.get(['/api/wallet', '/api/auth/wallet', '/api/user-orders/wallet'], requireUserAuth, async (req, res) => {
  try {
    try {
      await ensureCustomerCreditsSchema()
    } catch {
      // ignore
    }

    const tokenUserId = Number(req.user?.id)
    if (!Number.isFinite(tokenUserId) || tokenUserId <= 0) return res.status(401).json({ error: 'Invalid token' })

    const connection = await pool.getConnection()
    try {
      // IMPORTANT:
      // Credits are stored against users.id (as used by admin-service).
      // Some deployments have user JWTs where payload.id doesn't match users.id.
      // Resolve canonical users.id by email, falling back to token id.
      let effectiveUserId = tokenUserId
      const tokenEmail = String(req.user?.email || '').trim().toLowerCase()
      if (tokenEmail && tokenEmail.includes('@')) {
        try {
          const [idRows] = await connection.execute(
            'SELECT id FROM users WHERE LOWER(TRIM(email)) = ? LIMIT 1',
            [tokenEmail]
          )
          const resolvedId = Number(Array.isArray(idRows) && idRows[0] ? idRows[0].id : NaN)
          if (Number.isFinite(resolvedId) && resolvedId > 0) {
            effectiveUserId = resolvedId
          }
        } catch {
          // ignore
        }
      }

      await connection.execute('INSERT IGNORE INTO user_credits (user_id, balance) VALUES (?, 0.00)', [effectiveUserId])

      const [balRows] = await connection.execute('SELECT COALESCE(balance, 0) AS balance FROM user_credits WHERE user_id = ? LIMIT 1', [effectiveUserId])
      const balList = Array.isArray(balRows) ? balRows : []
      const balance = Number(balList[0]?.balance || 0)

      const [ledgerRows] = await connection.execute(
        `SELECT
          amount,
          source,
          order_number,
          admin_username,
          note,
          created_at
        FROM credit_ledger
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 50`,
        [effectiveUserId]
      )

      const ledger = (Array.isArray(ledgerRows) ? ledgerRows : []).map((r) => ({
        amount: Number(r?.amount || 0),
        source: String(r?.source || '').trim(),
        order_number: r?.order_number ? String(r.order_number).trim() : null,
        admin_username: r?.admin_username ? String(r.admin_username).trim() : null,
        note: r?.note ? String(r.note).trim() : null,
        created_at: r?.created_at || null,
      }))

      return res.json({ success: true, balance, ledger })
    } finally {
      connection.release()
    }
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to load wallet' })
  }
})



app.post(['/api/promos/validate', '/api/auth/promos/validate'], async (req, res) => {
  let connection
  try {
    const code = String(req.body?.code || req.body?.promoCode || '').trim().toUpperCase()
    if (!code) return res.status(400).json({ ok: false, error: 'code is required' })

    connection = await pool.getConnection()
    const percent = await resolvePromoPercent(connection, code)
    if (!Number.isFinite(percent) || percent <= 0) return res.status(404).json({ ok: false, valid: false })
    return res.json({ ok: true, valid: true, percent })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to validate promo' })
  } finally {
    if (connection) connection.release()
  }
})



app.get(['/api/affiliate/status', '/api/auth/affiliate/status'], requireUserAuth, async (req, res) => {
  let connection
  try {
    const userId = Number(req.user?.id)
    if (!Number.isFinite(userId) || userId <= 0) return res.status(401).json({ ok: false, error: 'Invalid token' })

    try {
      await ensureAffiliateSchema()
    } catch {
      // ignore
    }

    connection = await pool.getConnection()
    const [rows] = await connection.execute(
      `SELECT id, status, promo_code, promo_percent, created_at, decided_at
       FROM affiliate_requests
       WHERE user_id = ?
       LIMIT 1`,
      [userId]
    )
    const r = Array.isArray(rows) && rows[0] ? rows[0] : null
    if (!r?.id) return res.json({ ok: true, hasRequest: false })

    return res.json({
      ok: true,
      hasRequest: true,
      request: {
        id: Number(r.id),
        status: String(r.status || 'pending'),
        promo_code: r.promo_code ? String(r.promo_code) : null,
        promo_percent: r.promo_percent !== null && r.promo_percent !== undefined ? Number(r.promo_percent) : null,
        created_at: r.created_at || null,
        decided_at: r.decided_at || null,
      },
    })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to load affiliate status' })
  } finally {
    if (connection) connection.release()
  }
})



function splitFirstName(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  return s.split(/\s+/g)[0] || ''
}

function sanitizePromoToken(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 32)
}

async function generateUniqueAffiliatePromoCode(connection, userName, percent) {
  const p = Number(percent)
  const pct = Number.isFinite(p) && p > 0 ? Math.trunc(p) : 10

  const first = sanitizePromoToken(splitFirstName(userName))
  const baseName = first || 'USER'
  const base = `A${baseName}${pct}`

  const candidates = [base]
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    candidates.push(`${base}${ch}`)
    if (candidates.length >= 30) break
  }

  for (const code of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const [rows] = await connection.execute('SELECT id FROM promo_codes WHERE code = ? LIMIT 1', [code])
    const exists = Array.isArray(rows) && rows[0]
    if (!exists) return code
  }

  return `${base}${String(Date.now()).slice(-4)}`.slice(0, 64)
}

const AFFILIATE_DEFAULT_PERCENT = 10
const AFFILIATE_DEFAULT_REWARD = 40

app.post(['/api/affiliate/request', '/api/auth/affiliate/request'], requireUserAuth, async (req, res) => {
  let connection
  try {
    const userId = Number(req.user?.id)
    if (!Number.isFinite(userId) || userId <= 0) return res.status(401).json({ ok: false, error: 'Invalid token' })

    const userEmail = String(req.user?.email || '').trim().toLowerCase()
    if (!userEmail || !userEmail.includes('@')) return res.status(400).json({ ok: false, error: 'Missing user email' })

    const firstName = String(req.body?.first_name || '').trim().slice(0, 64)
    const lastName = String(req.body?.last_name || '').trim().slice(0, 64)
    const tiktokLink = String(req.body?.tiktok_link || '').trim().slice(0, 255)

    if (!firstName) return res.status(400).json({ ok: false, error: 'First name is required' })
    if (!lastName) return res.status(400).json({ ok: false, error: 'Last name is required' })
    if (!tiktokLink) return res.status(400).json({ ok: false, error: 'TikTok link is required' })
    const tiktokLower = tiktokLink.toLowerCase()
    const isTikTokUrl = tiktokLower.includes('tiktok.com')
    const isTikTokHandle = tiktokLink.startsWith('@')
    if (!isTikTokUrl && !isTikTokHandle) {
      return res.status(400).json({ ok: false, error: 'TikTok link must contain tiktok.com or start with @' })
    }

    try {
      await ensureAffiliateSchema()
    } catch {
      // ignore
    }

    connection = await pool.getConnection()
    await connection.beginTransaction()

    const userName = `${firstName} ${lastName}`.trim()

    const [existing] = await connection.execute(
      `SELECT id, status, promo_code, promo_percent
       FROM affiliate_requests
       WHERE user_id = ?
       LIMIT 1 FOR UPDATE`,
      [userId]
    )
    const ex = Array.isArray(existing) && existing[0] ? existing[0] : null
    if (ex?.id) {
      await connection.commit()
      return res.json({
        ok: true,
        alreadyRequested: true,
        status: String(ex.status || 'pending'),
        promo_code: ex.promo_code ? String(ex.promo_code) : null,
        promo_percent: ex.promo_percent !== null && ex.promo_percent !== undefined ? Number(ex.promo_percent) : null,
        reward_amount: AFFILIATE_DEFAULT_REWARD,
      })
    }

    const percent = AFFILIATE_DEFAULT_PERCENT
    const promoCode = await generateUniqueAffiliatePromoCode(connection, userName, percent)
    const now = nowMysqlDatetime()

    await connection.execute(
      `INSERT INTO affiliate_requests
        (user_id, user_email, user_name, first_name, last_name, tiktok_link, status, promo_code, promo_percent, decided_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?)`,
      [userId, userEmail, userName || null, firstName, lastName, tiktokLink, promoCode, percent, now, now]
    )

    await connection.execute(
      `INSERT INTO promo_codes (code, percent, source, user_id, is_active, created_at)
       VALUES (?, ?, 'affiliate', ?, 1, ?)
       ON DUPLICATE KEY UPDATE percent = VALUES(percent), is_active = 1, user_id = VALUES(user_id), updated_at = CURRENT_TIMESTAMP`,
      [promoCode, percent, userId, now]
    )

    await connection.execute(
      `INSERT INTO affiliates
        (user_id, promo_code, promo_percent, reward_amount, status, first_name, last_name, tiktok_link, approved_at, created_at)
       VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         promo_code = VALUES(promo_code),
         promo_percent = VALUES(promo_percent),
         reward_amount = VALUES(reward_amount),
         status = 'approved',
         first_name = VALUES(first_name),
         last_name = VALUES(last_name),
         tiktok_link = VALUES(tiktok_link),
         approved_at = VALUES(approved_at),
         updated_at = CURRENT_TIMESTAMP`,
      [userId, promoCode, percent, AFFILIATE_DEFAULT_REWARD, firstName, lastName, tiktokLink, now, now]
    )

    await connection.commit()

    // Fire-and-forget welcome email. Email failures must never break the API response.
    try {
      void sendAffiliateWelcomeEmail(userEmail, {
        firstName,
        promoCode,
        percent,
        rewardAmount: AFFILIATE_DEFAULT_REWARD,
      }).catch((err) => {
        console.error('Failed to send affiliate welcome email:', err?.message || String(err))
      })
    } catch (err) {
      console.error('Failed to dispatch affiliate welcome email:', err?.message || String(err))
    }

    return res.json({
      ok: true,
      approved: true,
      status: 'approved',
      promo_code: promoCode,
      promo_percent: percent,
      reward_amount: AFFILIATE_DEFAULT_REWARD,
    })
  } catch (e) {
    if (connection) {
      try {
        await connection.rollback()
      } catch {
        // ignore
      }
    }
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to request affiliate' })
  } finally {
    if (connection) connection.release()
  }
})



app.get(['/api/affiliate/dashboard', '/api/auth/affiliate/dashboard'], requireUserAuth, async (req, res) => {
  let connection
  try {
    const userId = Number(req.user?.id)
    if (!Number.isFinite(userId) || userId <= 0) return res.status(401).json({ ok: false, error: 'Invalid token' })

    try {
      await ensureAffiliateSchema()
    } catch {
      // ignore
    }
    try {
      await ensureCustomerCreditsSchema()
    } catch {
      // ignore
    }

    connection = await pool.getConnection()

    const [affRows] = await connection.execute(
      `SELECT a.promo_code, a.promo_percent, a.reward_amount, a.status,
              a.first_name, a.last_name, a.tiktok_link,
              pc.is_active AS code_active
       FROM affiliates a
       LEFT JOIN promo_codes pc ON pc.code = a.promo_code AND LOWER(pc.source) = 'affiliate'
       WHERE a.user_id = ?
       LIMIT 1`,
      [userId]
    )
    const aff = Array.isArray(affRows) && affRows[0] ? affRows[0] : null

    if (!aff?.promo_code) {
      return res.json({ ok: true, is_affiliate: false })
    }

    const codeActive = aff.code_active === null || aff.code_active === undefined ? 1 : Number(aff.code_active)
    const status = String(aff.status || '').toLowerCase()
    const effectiveStatus = (codeActive === 0 || status === 'revoked') ? 'revoked' : (status || 'approved')

    const [walletRows] = await connection.execute(
      'SELECT COALESCE(balance, 0) AS balance FROM user_credits WHERE user_id = ? LIMIT 1',
      [userId]
    )
    const walletBalance = Array.isArray(walletRows) && walletRows[0]
      ? Number(walletRows[0].balance || 0)
      : 0

    const [earnedRows] = await connection.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM credit_ledger
       WHERE user_id = ? AND source = 'affiliate_reward'`,
      [userId]
    )
    const totalEarned = Array.isArray(earnedRows) && earnedRows[0]
      ? Number(earnedRows[0].total || 0)
      : 0

    const [uniqRows] = await connection.execute(
      `SELECT COUNT(DISTINCT customer_email) AS uniq
       FROM promo_redemptions
       WHERE affiliate_user_id = ?`,
      [userId]
    )
    const uniqueCustomers = Array.isArray(uniqRows) && uniqRows[0]
      ? Number(uniqRows[0].uniq || 0)
      : 0

    const [recentRows] = await connection.execute(
      `SELECT order_number, customer_email, reward_amount, created_at
       FROM promo_redemptions
       WHERE affiliate_user_id = ?
       ORDER BY id DESC
       LIMIT 10`,
      [userId]
    )
    const maskEmail = (email) => {
      const s = String(email || '').trim().toLowerCase()
      const at = s.indexOf('@')
      if (at <= 0) return s ? `${s.slice(0, 1)}***` : ''
      return `${s.slice(0, 1)}***${s.slice(at)}`
    }
    const recentRedemptions = (Array.isArray(recentRows) ? recentRows : []).map((r) => ({
      order_number: String(r.order_number || ''),
      customer_email_masked: maskEmail(r.customer_email),
      reward_amount: Number(r.reward_amount || 0),
      created_at: r.created_at || null,
    }))

    return res.json({
      ok: true,
      is_affiliate: true,
      promo_code: String(aff.promo_code),
      promo_percent: aff.promo_percent !== null && aff.promo_percent !== undefined
        ? Number(aff.promo_percent)
        : AFFILIATE_DEFAULT_PERCENT,
      reward_amount: aff.reward_amount !== null && aff.reward_amount !== undefined
        ? Number(aff.reward_amount)
        : AFFILIATE_DEFAULT_REWARD,
      status: effectiveStatus,
      first_name: aff.first_name ? String(aff.first_name) : null,
      last_name: aff.last_name ? String(aff.last_name) : null,
      tiktok_link: aff.tiktok_link ? String(aff.tiktok_link) : null,
      wallet_balance: Number(walletBalance.toFixed(2)),
      total_earned: Number(totalEarned.toFixed(2)),
      unique_customers: uniqueCustomers,
      recent_redemptions: recentRedemptions,
    })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to load affiliate dashboard' })
  } finally {
    if (connection) connection.release()
  }
})



app.post('/api/products/klyme-status', async (req, res) => {

  try {

    const { product_ids } = req.body || {}



    if (!Array.isArray(product_ids) || product_ids.length === 0) {

      return res.status(400).json({ error: 'Product IDs array is required' })

    }



    const ids = product_ids.map((id) => String(id || '').trim()).filter(Boolean)

    if (!ids.length) return res.status(400).json({ error: 'Product IDs array is required' })



    const placeholders = ids.map(() => '?').join(',')

    const [products] = await pool.execute(

      `SELECT product_id, klyme_enabled FROM product_config WHERE product_id IN (${placeholders})`,

      ids

    )



    const klymeSettings = {}

      ; (Array.isArray(products) ? products : []).forEach((p) => {

        const pid = String(p?.product_id || '').trim()

        if (!pid) return

        klymeSettings[pid] = Boolean(p?.klyme_enabled)

      })

    // Force-enable Klyme for frontend Klyme-only products.
    ids.forEach((id) => {
      if (
        id === 'retatrutide-20mg' ||
        id === 'retatrutide-40mg' ||
        id === 'bundle-retatrutide-20mg-x2' ||
        id === 'bundle-retatrutide-40mg-x2' ||
        id === 'glow-70mg' ||
        id === 'bpc-157-tb-500-40mg'
      ) {
        klymeSettings[id] = true
      }
    })



    ids.forEach((id) => {

      if (!(id in klymeSettings)) klymeSettings[id] = false

    })



    return res.json({ klyme_settings: klymeSettings })

  } catch (e) {

    console.error('[products/klyme-status] failed', e?.message || e)

    return res.status(500).json({ error: 'Failed to check products Klyme status' })

  }

})



app.post('/api/products/klyme-status-by-sku', async (req, res) => {

  try {

    const { product_skus } = req.body || {}



    if (!Array.isArray(product_skus) || product_skus.length === 0) {

      return res.status(400).json({ error: 'Product SKUs array is required' })

    }



    const normalizeSku = (raw) => String(raw || '').trim().toUpperCase()

    const skus = product_skus.map(normalizeSku).filter(Boolean)
    if (!skus.length) return res.status(400).json({ error: 'Product SKUs array is required' })



    const placeholders = skus.map(() => '?').join(',')

    const [products] = await pool.execute(
      `SELECT product_sku, klyme_enabled FROM product_config WHERE UPPER(TRIM(product_sku)) IN (${placeholders})`,
      skus
    )



    const klymeSettings = {}
      ; (Array.isArray(products) ? products : []).forEach((p) => {
        const sku = normalizeSku(p?.product_sku)
        if (!sku) return
        klymeSettings[sku] = Boolean(p?.klyme_enabled)
      })

    skus.forEach((sku) => {
      if (
        sku === 'RETAT-20MG' ||
        sku === 'RETAT-40MG' ||
        sku === 'GLOW-70MG' ||
        sku === 'BPC-TB-40MG'
      ) {
        klymeSettings[sku] = true
      }
    })

    skus.forEach((sku) => {
      if (!(sku in klymeSettings)) klymeSettings[sku] = false
    })

    return res.json({ klyme_settings: klymeSettings })

  } catch (e) {

    console.error('[products/klyme-status-by-sku] failed', e?.message || e)

    return res.status(500).json({ error: 'Failed to check products Klyme status' })

  }

})



app.post('/api/products/klyme-status-by-name', async (req, res) => {

  try {

    const { product_names } = req.body || {}



    if (!Array.isArray(product_names) || product_names.length === 0) {

      return res.status(400).json({ error: 'Product names array is required' })

    }



    const normalizeName = (raw) => String(raw || '')

      .trim()

      .toLowerCase()

      .replace(/\s+/g, ' ')



    const names = product_names.map(normalizeName).filter(Boolean)

    if (!names.length) return res.status(400).json({ error: 'Product names array is required' })



    const placeholders = names.map(() => '?').join(',')

    const [products] = await pool.execute(

      `SELECT product_name, klyme_enabled

       FROM product_config

       WHERE LOWER(TRIM(REGEXP_REPLACE(product_name, '\\s+', ' '))) IN (${placeholders})`,

      names

    )



    const klymeSettings = {}

      ; (Array.isArray(products) ? products : []).forEach((p) => {

        const key = normalizeName(p?.product_name)

        if (!key) return

        klymeSettings[key] = Boolean(p?.klyme_enabled)

      })

    // Force-enable Klyme for frontend Klyme-only products.
    names.forEach((n) => {
      if (
        n === 'retatrutide 20mg' ||
        n === 'retatrutide 40mg' ||
        n === 'glow 70mg' ||
        n === 'bpc-157 & tb-500 40mg'
      ) {
        klymeSettings[n] = true
      }
    })



    names.forEach((n) => {

      if (!(n in klymeSettings)) klymeSettings[n] = false

    })



    return res.json({ klyme_settings: klymeSettings })

  } catch (e) {

    console.error('[products/klyme-status-by-name] failed', e?.message || e)

    return res.status(500).json({ error: 'Failed to check products Klyme status' })

  }

})



async function isProcessorEnabledOrder({ orderId, payload }) {

  try {

    // If the order is explicitly marked as Klyme, treat it as enabled regardless of product_config.
    if (Number.isFinite(Number(orderId)) && Number(orderId) > 0) {
      try {
        const [oRows] = await pool.execute('SELECT payment_method FROM orders WHERE id = ? LIMIT 1', [Number(orderId)])
        const o = Array.isArray(oRows) && oRows[0] ? oRows[0] : null
        const pm = String(o?.payment_method || '').trim().toLowerCase()
        if (pm === 'klyme') return true
      } catch {
        // ignore and fall back to product-based detection
      }
    }

    const idsFromPayload = []

    const itemsArray = Array.isArray(payload?.itemsArray)

      ? payload.itemsArray

      : (Array.isArray(payload?.items) ? payload.items : [])



    for (const it of itemsArray) {

      const pid = String(it?.productId || it?.id || '').trim()

      if (pid) idsFromPayload.push(pid)

    }



    let productIds = [...new Set(idsFromPayload)]



    if (!productIds.length && Number.isFinite(Number(orderId)) && Number(orderId) > 0) {

      const [rows] = await pool.execute(

        'SELECT DISTINCT product_id FROM order_items WHERE order_id = ? AND product_id IS NOT NULL',

        [Number(orderId)]

      )

      const found = Array.isArray(rows) ? rows.map((r) => String(r?.product_id || '').trim()).filter(Boolean) : []

      productIds = [...new Set(found)]

    }



    if (!productIds.length) return false

    // Ensure frontend-forced Klyme-only products are recognized server-side too.
    if (
      productIds.some(
        (id) =>
          id === 'retatrutide-20mg' ||
          id === 'retatrutide-40mg' ||
          id === 'bundle-retatrutide-20mg-x2' ||
          id === 'bundle-retatrutide-40mg-x2' ||
          id === 'glow-70mg' ||
          id === 'bpc-157-tb-500-40mg'
      )
    )
      return true



    const placeholders = productIds.map(() => '?').join(',')

    const [cfgRows] = await pool.execute(

      `SELECT product_id FROM product_config WHERE klyme_enabled = TRUE AND product_id IN (${placeholders}) LIMIT 1`,

      productIds

    )

    return Array.isArray(cfgRows) && cfgRows.length > 0

  } catch (e) {

    console.error('[user-orders] isProcessorEnabledOrder failed', e?.message || e)

    return false

  }

}



async function ensurePaymentSessionsEmailTrackingColumns() {

  const isMissingTable = (err) => {

    const code = String(err?.code || '').toUpperCase()

    const msg = String(err?.message || '').toLowerCase()

    return code === 'ER_NO_SUCH_TABLE' || msg.includes('doesn\'t exist') || msg.includes('no such table')

  }



  const isDuplicate = (err) => {

    const msg = String(err?.message || '').toLowerCase()

    return msg.includes('duplicate') || msg.includes('exists')

  }



  try {

    await pool.execute('ALTER TABLE payment_sessions ADD COLUMN success_email_sent_at DATETIME NULL')

  } catch (e) {

    if (!isDuplicate(e) && !isMissingTable(e)) {

      console.error('Failed to ensure payment_sessions.success_email_sent_at:', e?.message || String(e))

    }

  }

  try {

    await pool.execute('ALTER TABLE payment_sessions ADD COLUMN delivery_email_sent_at DATETIME NULL')

  } catch (e) {

    if (!isDuplicate(e) && !isMissingTable(e)) {

      console.error('Failed to ensure payment_sessions.delivery_email_sent_at:', e?.message || String(e))

    }

  }

  try {

    await pool.execute('ALTER TABLE payment_sessions ADD COLUMN rejected_email_sent_at DATETIME NULL')

  } catch (e) {

    if (!isDuplicate(e) && !isMissingTable(e)) {

      console.error('Failed to ensure payment_sessions.rejected_email_sent_at:', e?.message || String(e))

    }

  }



  try {

    await pool.execute('ALTER TABLE payment_sessions ADD COLUMN reminder_email_sent_at DATETIME NULL')

  } catch (e) {

    if (!isDuplicate(e) && !isMissingTable(e)) {

      console.error('Failed to ensure payment_sessions.reminder_email_sent_at:', e?.message || String(e))

    }

  }

}



async function ensurePaymentCaptureTable() {

  await pool.execute(

    `CREATE TABLE IF NOT EXISTS payment_capture_requests (

      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

      order_id BIGINT UNSIGNED NOT NULL,

      email VARCHAR(255) NULL,

      token_hash CHAR(64) NOT NULL,

      expires_at DATETIME NOT NULL,

      used_at DATETIME NULL,

      email_sent_at DATETIME NULL,

      email_send_error VARCHAR(255) NULL,

      created_at DATETIME NOT NULL,

      PRIMARY KEY (id),

      UNIQUE KEY uniq_token_hash (token_hash),

      KEY idx_order_id (order_id),

      KEY idx_expires_at (expires_at)

    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`

  )

}



async function ensurePaymentCaptureEmailTrackingColumns() {

  try {

    await pool.execute('ALTER TABLE payment_capture_requests ADD COLUMN email_sent_at DATETIME NULL')

  } catch (e) {

    const msg = String(e?.message || e)

    if (msg.toLowerCase().includes('duplicate column') || msg.toLowerCase().includes('exists')) {

      // ignore

    } else {

      console.error('Failed to ensure email_sent_at column:', msg)

    }

  }

  try {

    await pool.execute('ALTER TABLE payment_capture_requests ADD COLUMN email_send_error VARCHAR(255) NULL')

  } catch (e) {

    const msg = String(e?.message || e)

    if (msg.toLowerCase().includes('duplicate column') || msg.toLowerCase().includes('exists')) {

      // ignore

    } else {

      console.error('Failed to ensure email_send_error column:', msg)

    }

  }

}



async function ensureOrdersPaymentRejectionReasonColumn() {

  try {

    await pool.execute(

      `ALTER TABLE orders

        ADD COLUMN payment_rejection_reason VARCHAR(255) NULL`

    )

  } catch (e) {

    const msg = String(e?.message || e)

    if (msg.toLowerCase().includes('duplicate column') || msg.toLowerCase().includes('exists')) return

    console.error('Failed to ensure payment_rejection_reason column:', msg)

  }

}



async function ensurePasswordResetTokensTable() {

  await pool.execute(

    `CREATE TABLE IF NOT EXISTS password_reset_tokens (

      id INT UNSIGNED NOT NULL AUTO_INCREMENT,

      user_id INT NOT NULL,

      token VARCHAR(255) NOT NULL,

      expires_at DATETIME NOT NULL,

      used_at DATETIME NULL,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      PRIMARY KEY (id),

      UNIQUE KEY uq_password_reset_token (token),

      KEY idx_password_reset_expires_at (expires_at),

      CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE

    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`

  )

}



async function ensureCustomerBlacklistTable() {

  try {

    await pool.execute(

      `CREATE TABLE IF NOT EXISTS customer_blacklist (

        id INT AUTO_INCREMENT PRIMARY KEY,

        email_lower VARCHAR(255) NULL,

        address_key VARCHAR(512) NULL,

        reason VARCHAR(255) NULL,

        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

        INDEX idx_customer_blacklist_email (email_lower),

        INDEX idx_customer_blacklist_address (address_key)

      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`

    )

  } catch (e) {

    console.error('Failed to ensure customer_blacklist table:', e?.message || String(e))

  }

}



async function ensureUsersAuthColumns() {

  try {

    await pool.execute('ALTER TABLE users ADD COLUMN date_of_birth DATE NULL')

  } catch (e) {

    const msg = String(e?.message || e)

    if (msg.toLowerCase().includes('duplicate column') || msg.toLowerCase().includes('exists')) {

      // ignore

    } else {

      console.error('Failed to ensure date_of_birth column:', msg)

    }

  }

  try {

    await pool.execute('ALTER TABLE users ADD COLUMN nationality VARCHAR(100) NULL')

  } catch (e) {

    const msg = String(e?.message || e)

    if (msg.toLowerCase().includes('duplicate column') || msg.toLowerCase().includes('exists')) {

      // ignore

    } else {

      console.error('Failed to ensure nationality column:', msg)

    }

  }

  try {

    await pool.execute('ALTER TABLE users ADD COLUMN country_of_residence VARCHAR(100) NULL')

  } catch (e) {

    const msg = String(e?.message || e)

    if (msg.toLowerCase().includes('duplicate column') || msg.toLowerCase().includes('exists')) {

      // ignore

    } else {

      console.error('Failed to ensure country_of_residence column:', msg)

    }

  }

}



// Static hosting for uploaded files

app.use('/uploads', express.static(UPLOADS_DIR))



function strip4ByteUnicode(input) {

  if (input === null || input === undefined) return input

  return String(input).replace(/[\u{10000}-\u{10FFFF}]/gu, '')

}



function normalizeBlacklistEmail(raw) {

  const s = String(raw || '').trim().toLowerCase()

  if (!s || !s.includes('@')) return ''

  return s.slice(0, 255)

}



function normalizeBlacklistAddressKey(parts) {

  const address = String(parts?.address || parts?.shippingAddress || parts?.shipping_address || '').trim().toLowerCase()

  const city = String(parts?.city || parts?.shippingCity || parts?.shipping_city || '').trim().toLowerCase()

  const postcode = String(parts?.postcode || parts?.shippingZip || parts?.shipping_zip || '').trim().toLowerCase()

  const country = String(parts?.country || parts?.shippingCountry || parts?.shipping_country || '').trim().toLowerCase()

  const combined = `${address}|${city}|${postcode}|${country}`.replace(/\s+/g, ' ').trim()

  if (!combined || combined === '|||') return ''

  return combined.slice(0, 512)

}



async function assertNotBlacklisted(connection, payload) {

  const emailLower = normalizeBlacklistEmail(payload?.email || payload?.customerEmail)

  const addressKey = normalizeBlacklistAddressKey(payload)



  if (!emailLower && !addressKey) return



  try {

    await ensureCustomerBlacklistTable()

  } catch {

    // ignore

  }



  const clauses = []

  const params = []

  if (emailLower) {

    clauses.push('email_lower = ?')

    params.push(emailLower)

  }

  if (addressKey) {

    clauses.push('address_key = ?')

    params.push(addressKey)

  }

  if (!clauses.length) return



  const [rows] = await connection.execute(

    `SELECT id, reason FROM customer_blacklist WHERE ${clauses.join(' OR ')} ORDER BY id DESC LIMIT 1`,

    params

  )

  const hit = Array.isArray(rows) && rows[0] ? rows[0] : null

  if (hit) {

    const reason = String(hit.reason || '').trim()

    const err = new Error(reason ? `Customer is blacklisted: ${reason}` : 'Customer is blacklisted')

    err.code = 'CUSTOMER_BLACKLISTED'

    throw err

  }

}



function toMysqlDatetimeFromIso(iso) {

  if (!iso) return null

  const d = new Date(iso)

  if (Number.isNaN(d.getTime())) return null

  const base = d.toISOString().substring(0, 19).replace('T', ' ')

  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(base)) return null

  return base

}



function nowMysqlDatetime() {

  const d = new Date()

  const pad = (n) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

}



async function applyAvailableCreditsToOrder(connection, orderNumber, opts) {
  const now = nowMysqlDatetime()
  const source = String(opts?.source || 'order_apply').trim() || 'order_apply'
  const allowUpdatePaymentAmount = !!opts?.allowUpdatePaymentAmount

  const [orderRows] = await connection.execute(
    'SELECT id, order_number, customer_email, total, credits_applied FROM orders WHERE order_number = ? LIMIT 1',
    [orderNumber]
  )
  const order = Array.isArray(orderRows) && orderRows[0] ? orderRows[0] : null
  if (!order?.id) return { ok: false, reason: 'order_not_found' }

  const alreadyApplied = Number(order?.credits_applied || 0)
  if (Number.isFinite(alreadyApplied) && alreadyApplied > 0) {
    return { ok: true, orderId: order.id, orderNumber: order.order_number, creditsApplied: alreadyApplied, alreadyApplied: true }
  }

  const email = String(order?.customer_email || '').trim().toLowerCase()
  if (!email || !email.includes('@')) return { ok: false, reason: 'missing_email' }

  try {
    try {
      await ensureCustomerCreditsSchema()
    } catch {
      // ignore
    }

    const [userRows] = await connection.execute('SELECT id FROM users WHERE email = ? LIMIT 1', [email])
    const userId = Array.isArray(userRows) && userRows[0] ? userRows[0].id : null
    if (!userId) return { ok: false, reason: 'user_not_found' }

    await connection.execute('INSERT IGNORE INTO user_credits (user_id, balance) VALUES (?, 0.00)', [userId])

    const [creditRows] = await connection.execute('SELECT balance FROM user_credits WHERE user_id = ? FOR UPDATE', [userId])
    const creditList = Array.isArray(creditRows) ? creditRows : []
    const balance = creditList.length ? Number((creditList[0]?.balance ?? 0) || 0) : 0
    const safeBalance = Number.isFinite(balance) ? balance : 0

    const safeTotal = Number.isFinite(Number(order?.total)) ? Number(order.total) : 0
    let creditsApplied = Math.max(0, Math.min(safeBalance, safeTotal))
    creditsApplied = Number(creditsApplied.toFixed(2))

    if (!(creditsApplied > 0)) {
      return { ok: true, orderId: order.id, orderNumber: order.order_number, creditsApplied: 0, alreadyApplied: false }
    }

    const payableTotal = Number((safeTotal - creditsApplied).toFixed(2))

    await connection.execute(
      'UPDATE user_credits SET balance = COALESCE(balance, 0) - ? WHERE user_id = ? LIMIT 1',
      [creditsApplied, userId]
    )

    await connection.execute(
      'INSERT INTO credit_ledger (user_id, amount, source, order_number, created_at) VALUES (?, ?, ?, ?, ?)',
      [userId, -creditsApplied, source, String(order.order_number || orderNumber), now]
    )

    await connection.execute(
      'UPDATE orders SET credits_applied = ?, total_before_credits = ?, total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? LIMIT 1',
      [creditsApplied, safeTotal, payableTotal, order.id]
    )

    if (allowUpdatePaymentAmount) {
      await connection.execute(
        'UPDATE payments SET amount = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?',
        [payableTotal, order.id]
      )
    }

    return {
      ok: true,
      orderId: order.id,
      orderNumber: order.order_number,
      creditsApplied,
      payableTotal,
      alreadyApplied: false,
    }
  } catch (e) {
    return { ok: false, reason: 'apply_failed', error: e?.message || String(e) }
  }
}



function addHoursMysql(hours) {

  const h = Number(hours)

  const d = new Date()

  if (Number.isFinite(h) && h !== 0) {

    d.setTime(d.getTime() + h * 60 * 60 * 1000)

  }

  const pad = (n) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

}



function generateOrderNumber() {

  const d = new Date()

  const pad = (n, w = 2) => String(n).padStart(w, '0')

  const y = d.getFullYear()

  const m = pad(d.getMonth() + 1)

  const day = pad(d.getDate())

  const hh = pad(d.getHours())

  const mm = pad(d.getMinutes())

  const ss = pad(d.getSeconds())

  const ms = pad(d.getMilliseconds(), 3)

  const rand = crypto.randomBytes(3).toString('hex').toUpperCase()

  return `ORD-${y}${m}${day}-${hh}${mm}${ss}${ms}-${rand}`

}



function stripAluToken(input) {

  const raw = String(input || '').trim()

  if (!raw) return ''

  const stripped = raw

    .replace(/^ALU[-_]?/i, '')

    .replace(/\bALU\b/gi, '')

    .replace(/ALU/gi, '')

    .replace(/--+/g, '-')

    .replace(/__+/g, '_')

    .replace(/^-+/, '')

    .replace(/-+$/, '')

    .trim()

  return stripped || raw

}



async function resolveUniqueOrderNumber(connection, requestedOrderNumber, emailLower) {

  let candidate = String(requestedOrderNumber || '').trim()

  if (!candidate) candidate = generateOrderNumber()



  for (let i = 0; i < 8; i++) {

    const [rows] = await connection.execute(

      'SELECT customer_email FROM orders WHERE order_number = ? LIMIT 1',

      [candidate]

    )

    const existingEmail =

      Array.isArray(rows) && rows[0] && rows[0].customer_email

        ? String(rows[0].customer_email).trim().toLowerCase()

        : ''



    if (!existingEmail) return candidate

    if (existingEmail === String(emailLower || '').trim().toLowerCase()) return candidate



    // Collision with a different customer's order_number; generate a new one.

    candidate = generateOrderNumber()

  }



  throw new Error('Failed to generate a unique order number after multiple attempts')

}



function sha256Hex(raw) {

  return crypto.createHash('sha256').update(String(raw || ''), 'utf8').digest('hex')

}



function randomToken() {

  return crypto.randomBytes(32).toString('hex')

}



function sanitizeForFilename(raw) {

  const s = String(raw || '')

    .normalize('NFKD')

    .replace(/[^a-zA-Z0-9]+/g, '')

    .trim()

  return s || 'file'

}



function fetchTimeoutMs() {

  const v = Number(env('PAYMENT_CAPTURE_VERIFY_TIMEOUT_MS', '25000'))

  return Number.isFinite(v) && v > 1000 ? v : 25000

}



async function fetchJsonWithTimeout(url, opts = {}) {

  const ms = fetchTimeoutMs()

  const ctrl = new AbortController()

  const t = setTimeout(() => ctrl.abort(), ms)

  try {

    const res = await fetch(url, { ...opts, signal: ctrl.signal })

    const data = await res.json().catch(() => ({}))

    return { ok: res.ok, status: res.status, data }

  } finally {

    clearTimeout(t)

  }

}



async function validateCaptureToken(connection, tokenRaw) {

  const token = String(tokenRaw || '').trim()

  if (!token) return { ok: false, status: 400, error: 'token is required' }



  const tokenHash = sha256Hex(token)

  const [rows] = await connection.execute(

    `SELECT id, order_id, email, token_hash, expires_at, used_at

     FROM payment_capture_requests

     WHERE token_hash = ?

     LIMIT 1`,

    [tokenHash]

  )



  const list = Array.isArray(rows) ? rows : []

  if (!list.length) return { ok: false, status: 404, error: 'Invalid or expired link' }

  const r = list[0]



  const exp = new Date(r.expires_at)

  if (Number.isNaN(exp.getTime()) || exp.getTime() < Date.now()) return { ok: false, status: 400, error: 'Link expired' }



  const [orderRows] = await connection.execute('SELECT * FROM orders WHERE id = ? LIMIT 1', [r.order_id])

  const orders = Array.isArray(orderRows) ? orderRows : []

  if (!orders.length) return { ok: false, status: 404, error: 'Order not found' }



  const order = orders[0]



  // If token was previously used, only block it if payment is already completed.

  // This makes the flow retry-safe for cases where the first upload timed out or verification failed.

  if (r.used_at) {

    const ps = String(order?.payment_status || '').trim().toLowerCase()

    const isFinalPaid = ['paid', 'received', 'succeeded', 'success', 'completed', 'complete'].includes(ps)

    if (isFinalPaid) return { ok: false, status: 400, error: 'Link already used' }

  }

  if (r.email && order.customer_email && String(order.customer_email).toLowerCase() !== String(r.email).toLowerCase()) {

    return { ok: false, status: 400, error: 'Invalid link' }

  }



  const [itemsRows] = await connection.execute('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [r.order_id])

  const [paymentsRows] = await connection.execute('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC', [r.order_id])



  return {

    ok: true,

    request: r,

    order,

    items: Array.isArray(itemsRows) ? itemsRows : [],

    payments: Array.isArray(paymentsRows) ? paymentsRows : [],

  }

}



function parseMoney(raw) {

  if (raw === null || raw === undefined) return 0

  const s = String(raw).replace(/£/g, '').trim()

  const n = Number(s)

  return Number.isFinite(n) ? n : 0

}



function parsePercent(raw) {

  if (raw === null || raw === undefined) return 0

  const s = String(raw).trim()

  const n = Number(s)

  return Number.isFinite(n) ? n : 0

}



function parseItemsText(itemsText) {

  const items = []

  const raw = String(itemsText || '').trim()

  if (!raw) return items



  const parts = raw.split(' | ').map((p) => p.trim()).filter(Boolean)

  for (const part of parts) {

    const m = part.match(/^(.*)\s+x(\d+)\s+@\s+£?\s*([0-9]+(?:\.[0-9]+)?)\s*$/i)

    if (!m) continue

    const name = String(m[1] || '').trim()

    const qty = Number(m[2] || 0)

    const price = Number(m[3] || 0)

    if (!name || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price)) continue

    items.push({ name, quantity: qty, unitPrice: price })

  }

  return items

}



function slugifySku(name) {

  const base = String(name || '')

    .toLowerCase()

    .trim()

    .replace(/[^a-z0-9]+/g, '-')

    .replace(/^-+|-+$/g, '')

  return base ? base.substring(0, 100) : ''

}



const storage = multer.diskStorage({

  destination: function (_req, _file, cb) {

    try {

      fs.mkdirSync(UPLOADS_DIR, { recursive: true })

    } catch {

      // ignore

    }

    cb(null, UPLOADS_DIR)

  },

  filename: function (_req, file, cb) {

    const ext = path.extname(file.originalname || '') || '.jpg'

    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`

    cb(null, `${unique}${ext}`)

  },

})



const upload = multer({

  storage,

  limits: { fileSize: 25 * 1024 * 1024 },

})



const captureUpload = multer({

  storage,

  limits: { fileSize: 25 * 1024 * 1024 },

})



async function persistOrderFromCheckout(connection, payload, opts) {

  const createdAt = toMysqlDatetimeFromIso(payload.createdAtIso) || nowMysqlDatetime()

  // Debug logging for credits
  console.log('[persistOrderFromCheckout] Payload received:', {
    creditsApplied: payload.creditsApplied,
    total: payload.total,
    paymentMethod: payload.paymentMethod
  })

  const email = String(payload.email || payload.customerEmail || '').trim().toLowerCase()

  if (!email || !email.includes('@')) throw new Error('Missing/invalid required field: email')



  await assertNotBlacklisted(connection, payload)



  const orderNumber = await resolveUniqueOrderNumber(

    connection,

    String(payload.orderId || payload.orderNumber || '').trim(),

    email

  )

  payload.orderId = orderNumber

  payload.orderNumber = orderNumber



  const firstName = String(payload.firstName || '').trim()

  const lastName = String(payload.lastName || '').trim()

  const customerName = strip4ByteUnicode(String(payload.customerName || `${firstName} ${lastName}`.trim())) || 'Customer'

  const phone = strip4ByteUnicode(String(payload.phone || payload.customerPhone || '').trim()) || null



  const address = strip4ByteUnicode(String(payload.address || payload.shippingAddress || '').trim()) || null

  const city = strip4ByteUnicode(String(payload.city || payload.shippingCity || '').trim()) || null

  const postcode = strip4ByteUnicode(String(payload.postcode || payload.shippingZip || '').trim()) || null

  const country = strip4ByteUnicode(String(payload.country || payload.shippingCountry || '').trim()) || null



  const itemsText = strip4ByteUnicode(String(payload.items || payload.itemsText || '').trim()) || null

  const isKlymeCheckout = isKlymeCheckoutPayload(payload, opts)

  // Check if order contains only AabanPay-eligible products
  const checkoutItemsArray = Array.isArray(payload.itemsArray) ? payload.itemsArray :
    Array.isArray(payload.items) ? payload.items : []
  const isAabanPayCheckout = checkoutItemsArray.length > 0 && checkoutItemsArray.every(item => {
    const productId = String(item.productId || item.product_id || item.id || '')
    return productId === '32' ||
      productId === 'test-product' ||
      productId === 'retatrutide-20mg' ||
      productId === 'retatrutide-40mg'
  })

  const paymentMethodLabel = isKlymeCheckout ? 'Klyme' : (isAabanPayCheckout ? 'AabanPay' : 'Manual')
  const bankAccountUsed = isKlymeCheckout ? 'klyme' : (isAabanPayCheckout ? 'aabanpay' : 'ibalticx')



  const hasBundleItem = orderItemsContainBundle(payload?.itemsArray || payload?.items)

  let promoCode = strip4ByteUnicode(String(payload.promoCode || payload.promo_code || '').trim())

  if (!promoCode || promoCode === '-' || promoCode.toLowerCase() === 'none') promoCode = null



  let promoDiscountPercent = parsePercent(payload.promoDiscount ?? payload.promo_discount_percent)

  const subtotal = parseMoney(payload.subtotal)

  let discountAmount = parseMoney(payload.discountAmount ?? payload.discount_amount)

  let total = parseMoney(payload.total)

  if (hasBundleItem) {
    promoCode = null
    promoDiscountPercent = 0
    discountAmount = 0
    total = subtotal
  }



  const screenshotFilename = payload.screenshotFilename ? strip4ByteUnicode(payload.screenshotFilename) : null

  const screenshotUrl = payload.screenshotUrl ? strip4ByteUnicode(payload.screenshotUrl) : null



  const importedPasswordHash = '$2a$10$g9wJ7lY0Xr8C7g3h2VqB3eQvVqkM2wQxY1s3h1jH8kqBq5dFQqz8G'



  await connection.execute(

    `INSERT INTO users (name, email, password_hash, phone, role)

     VALUES (?, ?, ?, ?, 'user')

     ON DUPLICATE KEY UPDATE

       name=VALUES(name),

       phone=COALESCE(VALUES(phone), phone),

       role=IF(role='admin', role, 'user')`,

    [customerName, email, importedPasswordHash, phone]

  )



  const [userRows] = await connection.execute('SELECT id FROM users WHERE email = ? LIMIT 1', [email])

  const userId = Array.isArray(userRows) && userRows[0] ? userRows[0].id : null

  // Credits are NOT deducted/applied during draft order creation.
  // We only apply credits once the order is finalized (e.g. payment initiated/received).
  const creditsApplied = 0
  const totalBeforeCredits = total

  // Apply credits immediately for manual orders and AabanPay orders
  const isManualOrder = !isKlymeCheckout
  let finalCreditsApplied = creditsApplied
  let finalTotal = total

  if (isManualOrder) {
    try {
      const creditResult = await applyAvailableCreditsToOrder(connection, orderNumber, {
        source: isAabanPayCheckout ? 'order_aabanpay_checkout' : 'order_manual_checkout',
        allowUpdatePaymentAmount: false
      })

      if (creditResult?.ok && creditResult?.creditsApplied > 0) {
        finalCreditsApplied = Number(creditResult.creditsApplied)
        finalTotal = Number(creditResult.payableTotal) || total
        console.log('[persistOrderFromCheckout] Credits applied:', {
          orderNumber,
          creditsApplied: finalCreditsApplied,
          newTotal: finalTotal,
          paymentMethod: paymentMethodLabel
        })
      } else {
        console.log('[persistOrderFromCheckout] No credits applied:', {
          orderNumber,
          reason: creditResult?.reason || 'no credits available',
          paymentMethod: paymentMethodLabel
        })
      }
    } catch (e) {
      console.error('[persistOrderFromCheckout] Failed to apply credits:', e)
      // Continue without credits if application fails
    }
  }



  if (userId) {

    await connection.execute('DELETE FROM user_addresses WHERE user_id = ? AND is_default = TRUE', [userId])

    await connection.execute(

      'INSERT INTO user_addresses (user_id, address_line1, city, postcode, country, is_default) VALUES (?, ?, ?, ?, ?, TRUE)',

      [userId, address || '', city, postcode, country]

    )

  }



  await connection.execute(

    `INSERT INTO orders (

       order_number, customer_email, customer_name, customer_phone,

       shipping_address, shipping_city, shipping_state, shipping_zip, shipping_country,

       currency, subtotal, shipping, total,

       credits_applied, total_before_credits,

       total_before_discount, total_after_discount, discount_amount,

       promo_code, promo_discount_percent, promo_valid,

       status, payment_status, payment_method,

       items_text, payment_screenshot_filename, payment_screenshot_url,

       bank_account_used, reserved_at, submitted_at, created_at

     ) VALUES (

       ?, ?, ?, ?,

       ?, ?, NULL, ?, ?,

       'GBP', ?, 0.00, ?,

       ?, ?,

       ?, ?, ?,

       ?, ?, ?,

       'pending', 'pending', ?,

       ?, ?, ?,

       ?, NULL, ?, ?

     )

     ON DUPLICATE KEY UPDATE

       customer_email=VALUES(customer_email),

       customer_name=VALUES(customer_name),

       customer_phone=VALUES(customer_phone),

       shipping_address=VALUES(shipping_address),

       shipping_city=VALUES(shipping_city),

       shipping_zip=VALUES(shipping_zip),

       shipping_country=VALUES(shipping_country),

       subtotal=VALUES(subtotal),

       total=VALUES(total),

       total_before_discount=VALUES(total_before_discount),

       total_after_discount=VALUES(total_after_discount),

       discount_amount=VALUES(discount_amount),

       promo_code=VALUES(promo_code),

       promo_discount_percent=VALUES(promo_discount_percent),

       promo_valid=VALUES(promo_valid),

       credits_applied=VALUES(credits_applied),

       total_before_credits=VALUES(total_before_credits),

       items_text=VALUES(items_text),

       payment_screenshot_filename=VALUES(payment_screenshot_filename),

       payment_screenshot_url=VALUES(payment_screenshot_url),

       submitted_at=COALESCE(VALUES(submitted_at), submitted_at),

       updated_at=CURRENT_TIMESTAMP`,

    [

      orderNumber,

      email,

      customerName,

      phone,

      address,

      city,

      postcode,

      country,

      subtotal,

      finalTotal,

      finalCreditsApplied,

      totalBeforeCredits,

      subtotal,

      finalTotal,

      discountAmount,

      promoCode,

      promoDiscountPercent,

      promoCode ? 1 : 0,

      itemsText,

      screenshotFilename,

      screenshotUrl,

      paymentMethodLabel,

      bankAccountUsed,

      createdAt,

      createdAt,

    ]

  )



  const [orderRows] = await connection.execute('SELECT id FROM orders WHERE order_number = ? LIMIT 1', [orderNumber])

  const orderId = Array.isArray(orderRows) && orderRows[0] ? orderRows[0].id : null

  if (!orderId) throw new Error('Failed to resolve order id after upsert')



  const providerId = opts?.providerId || `CHECKOUT-${orderNumber}`

  await connection.execute(

    `INSERT INTO payments (order_id, provider, provider_id, amount, currency, status, raw_response, created_at)

     VALUES (?, 'Manual', ?, ?, 'GBP', 'pending', NULL, ?)

     ON DUPLICATE KEY UPDATE

       order_id=VALUES(order_id),

       amount=VALUES(amount),

       currency=VALUES(currency),

       status=VALUES(status),

       updated_at=CURRENT_TIMESTAMP`,

    [orderId, providerId, total, createdAt]

  )



  await connection.execute('DELETE FROM order_items WHERE order_id = ?', [orderId])



  let itemsArray = []

  if (Array.isArray(payload.itemsArray)) itemsArray = payload.itemsArray

  else if (Array.isArray(payload.items)) itemsArray = payload.items



  const productExistsCache = new Map()

  const confirmedItems = []

  // If this checkout contains the special test product (ID 32), ensure it exists in products
  // so order_items.product_id FK constraints are satisfied.
  try {
    const maybe32 = (Array.isArray(itemsArray) ? itemsArray : []).some((it) => String(it?.productId ?? it?.product_id ?? it?.id ?? '').trim() === '32')
    if (maybe32) await ensureTestProduct32Exists(connection)
  } catch {
    // ignore
  }



  if (!itemsArray.length && itemsText) {

    const parsed = parseItemsText(itemsText)

    itemsArray = parsed.map((it) => ({ name: it.name, quantity: it.quantity, unitPrice: it.unitPrice }))

  }



  for (const it of itemsArray) {

    const name = strip4ByteUnicode(String(it.name || it.title || '').trim())

    if (!name) continue

    const quantity = Math.max(Number(it.quantity || 1), 1)

    const unitPrice = Number(it.unitPrice ?? it.priceNumber ?? it.price ?? 0)

    const safeUnit = Number.isFinite(unitPrice) ? unitPrice : 0

    const lineTotal = Number((safeUnit * quantity).toFixed(2))

    const sku = strip4ByteUnicode(String(it.sku || it.id || slugifySku(name)))



    const rawProductId = it.productId ?? it.product_id ?? it.id

    const numericProductId = Number(rawProductId)

    let productIdForDb = Number.isFinite(numericProductId) ? numericProductId : null

    // Allow persisting the special test product (ID 32) even if it's not present in the products table.
    // This keeps the order eligible for the AabanPay test flow.
    if (String(rawProductId || '').trim() === '32') {
      productIdForDb = 32
    }

    if (productIdForDb !== null) {

      const cached = productExistsCache.get(productIdForDb)

      if (cached === undefined) {

        const [prodRows] = await connection.execute('SELECT id FROM products WHERE id = ? LIMIT 1', [productIdForDb])

        const exists = Array.isArray(prodRows) && !!prodRows[0]

        productExistsCache.set(productIdForDb, exists)

        if (!exists && productIdForDb !== 32) productIdForDb = null

      } else if (!cached) {

        if (productIdForDb !== 32) productIdForDb = null

      }

    }



    await connection.execute(

      'INSERT INTO order_items (order_id, product_id, name, sku, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)',

      [orderId, productIdForDb, name, sku || null, quantity, safeUnit, lineTotal]

    )

    confirmedItems.push({ name, sku: sku || null, quantity, unitPrice: safeUnit, lineTotal })

  }



  return {
    orderId,
    orderNumber,
    customerName,
    customerEmail: email,
    phone,
    shippingAddress: address,
    shippingCity: city,
    shippingPostcode: postcode,
    shippingCountry: country,
    currency: 'GBP',
    subtotal,
    discountAmount,
    total: finalTotal,
    items: confirmedItems,
  }

}



app.get('/health', async (_req, res) => {

  try {

    await pool.query('SELECT 1')

    return res.json({ ok: true, service: 'user-order-creation', db: 'connected' })

  } catch (e) {

    return res.status(500).json({ ok: false, service: 'user-order-creation', db: 'disconnected', error: e?.message || String(e) })

  }

})



app.get('/api/user-orders/health', async (_req, res) => {

  try {

    await pool.query('SELECT 1')

    return res.json({ ok: true, service: 'user-order-creation', db: 'connected' })

  } catch (e) {

    return res.status(500).json({ ok: false, service: 'user-order-creation', db: 'disconnected', error: e?.message || String(e) })

  }

})



// Some legacy clients incorrectly call GET /api/user-orders/.

// The create order endpoint is POST /api/user-orders.

app.get(['/api/user-orders', '/api/user-orders/'], (_req, res) => {

  res.set('Allow', 'POST')

  return res.status(405).json({

    ok: false,

    error: 'Method Not Allowed. Use POST /api/user-orders to create an order.',

    service: 'user-order-creation',

  })

})



app.post('/api/payment-capture/validate', async (req, res) => {

  let connection

  try {

    connection = await pool.getConnection()

    const out = await validateCaptureToken(connection, req.body?.token)

    if (!out.ok) return res.status(out.status || 400).json({ ok: false, error: out.error || 'Invalid link' })



    const order = out.order

    const allowPromoBase = !order?.promo_code || String(order.promo_code).trim() === '' || String(order.promo_code).trim() === '-'
    const hasBundleItem = orderItemsContainBundle(out.items)
    const allowPromo = allowPromoBase && !hasBundleItem



    return res.json({

      ok: true,

      order,

      items: out.items,

      payments: out.payments,

      allowPromo,

      bank: {

        payeeName: '1066 Detailing Ltd',

        sortCode: '60-83-82',

        accountNumber: '46672542',

        reference: env('PAYMENT_REFERENCE', 'Beauty'),

      },

    })

  } catch (e) {

    return res.status(500).json({ ok: false, error: e?.message || 'Validation failed' })

  } finally {

    if (connection) connection.release()

  }

})



app.post('/api/payment-capture/apply-promo', async (req, res) => {

  let connection

  try {
    const token = String(req.body?.token || '').trim()

    const promoCode = String(req.body?.promoCode || '').trim().toUpperCase()

    if (!token) return res.status(400).json({ ok: false, error: 'token is required' })

    if (!promoCode) return res.status(400).json({ ok: false, error: 'promoCode is required' })



    connection = await pool.getConnection()

    await connection.beginTransaction()

    const percent = await resolvePromoPercent(connection, promoCode)
    if (!Number.isFinite(percent) || percent <= 0) {
      await connection.rollback()
      return res.status(400).json({ ok: false, error: 'Invalid promo code' })
    }



    const out = await validateCaptureToken(connection, token)

    if (!out.ok) {

      await connection.rollback()

      return res.status(out.status || 400).json({ ok: false, error: out.error || 'Invalid link' })

    }



    const order = out.order

    if (orderItemsContainBundle(out.items)) {
      await connection.rollback()
      return res.status(400).json({ ok: false, error: 'Promo codes cannot be applied to bundle products' })
    }

    const alreadyHasPromo = !!order?.promo_code && String(order.promo_code).trim() !== '' && String(order.promo_code).trim() !== '-'

    if (alreadyHasPromo) {

      await connection.rollback()

      return res.status(400).json({ ok: false, error: 'Promo already applied' })

    }



    const subtotal = Number(order?.subtotal ?? order?.total_before_discount ?? order?.total ?? 0)

    const safeSubtotal = Number.isFinite(subtotal) && subtotal > 0 ? subtotal : 0

    const discountAmount = Number(Math.min(safeSubtotal, safeSubtotal * (percent / 100)).toFixed(2))

    const totalAfter = Number((safeSubtotal - discountAmount).toFixed(2))



    await connection.execute(

      `UPDATE orders

        SET promo_code = ?, promo_discount_percent = ?, promo_valid = 1,

            discount_amount = ?, total_before_discount = ?, total_after_discount = ?,

            total = ?, updated_at = CURRENT_TIMESTAMP

        WHERE id = ? LIMIT 1`,

      [promoCode, percent, discountAmount, safeSubtotal, totalAfter, totalAfter, order.id]

    )



    await connection.execute(

      `UPDATE payments

        SET amount = ?, updated_at = CURRENT_TIMESTAMP

        WHERE order_id = ?`,

      [totalAfter, order.id]

    )



    await connection.commit()

    return res.json({ ok: true, promoCode, promoDiscountPercent: percent, discountAmount, total: totalAfter })

  } catch (e) {

    if (connection) {

      try {

        await connection.rollback()

      } catch {

        // ignore

      }

    }

    return res.status(500).json({ ok: false, error: e?.message || 'Failed to apply promo' })

  } finally {

    if (connection) connection.release()

  }

})



app.post('/api/payment-capture/upload', captureUpload.single('paymentScreenshot'), async (req, res) => {

  let connection

  try {

    const token = String(req.body?.token || '').trim()

    if (!token) {

      return res.status(400).json({

        ok: false,

        error: 'token is required',

      })

    }



    if (!req.file) {

      console.error('[payment-capture/upload] missing file', {

        contentType: req.headers['content-type'],

        bodyKeys: Object.keys(req.body || {}),

        hasToken: !!token,

      })

      return res.status(400).json({

        ok: false,

        error: 'paymentScreenshot file is required',

      })

    }



    connection = await pool.getConnection()

    await connection.beginTransaction()



    const out = await validateCaptureToken(connection, token)

    if (!out.ok) {

      await connection.rollback()

      return res.status(out.status || 400).json({ ok: false, error: out.error || 'Invalid link' })

    }



    const order = out.order

    const ext = path.extname(req.file.originalname || '') || path.extname(req.file.filename || '') || '.jpg'

    const safeCustomer = sanitizeForFilename(order.customer_name || 'customer')

    const safeOrder = sanitizeForFilename(order.order_number || String(order.id || 'order'))

    let newFilename = `${safeCustomer}${safeOrder}${ext}`

    const destPath = path.join(req.file.destination, newFilename)



    if (fs.existsSync(destPath)) {

      newFilename = `${safeCustomer}${safeOrder}-${Date.now()}${ext}`

    }



    const finalPath = path.join(req.file.destination, newFilename)

    try {

      await fs.promises.rename(req.file.path, finalPath)

    } catch {

      await fs.promises.copyFile(req.file.path, finalPath)

      await fs.promises.unlink(req.file.path)

    }



    const proto = req.headers['x-forwarded-proto'] || req.protocol

    const host = req.get('host')

    const base = PUBLIC_BASE_URL || `${proto}://${host}`

    const screenshotUrl = `${base}/uploads/${encodeURIComponent(newFilename)}`



    const tryUpdateScreenshot = async (sql, params) => {
      try {
        await connection.execute(sql, params)
        return true
      } catch (e) {
        const msg = String(e?.message || e)
        if (/unknown column/i.test(msg) || /ER_BAD_FIELD_ERROR/i.test(String(e?.code || ''))) return false
        throw e
      }
    }

    // Prefer storing both filename + public URL and a submitted timestamp, but degrade gracefully on older schemas.
    let screenshotUpdated = await tryUpdateScreenshot(
      `UPDATE orders
        SET payment_screenshot_filename = ?, payment_screenshot_url = ?, submitted_at = COALESCE(submitted_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
        WHERE id = ? LIMIT 1`,
      [newFilename, screenshotUrl, order.id]
    )

    if (!screenshotUpdated) {
      screenshotUpdated = await tryUpdateScreenshot(
        `UPDATE orders
          SET payment_screenshot_filename = ?, payment_screenshot_url = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? LIMIT 1`,
        [newFilename, screenshotUrl, order.id]
      )
    }

    if (!screenshotUpdated) {
      screenshotUpdated = await tryUpdateScreenshot(
        `UPDATE orders
          SET payment_screenshot_filename = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? LIMIT 1`,
        [newFilename, order.id]
      )
    }

    if (!screenshotUpdated) {
      // Last resort: do not block the flow—screenshot is still present on disk.
      console.error('[payment-capture/upload] failed to persist screenshot fields to orders table (continuing)', {
        orderId: order?.id,
        orderNumber: order?.order_number,
        filename: newFilename,
      })
    }



    await connection.commit()

    try {
      const customerEmail = String(order?.customer_email || '').trim()
      if (customerEmail && customerEmail.includes('@')) {
        const customerName = String(order?.customer_name || '').trim() || 'there'
        const orderNumber = String(order?.order_number || '').trim()
        const currency = String(order?.currency || 'GBP').trim() || 'GBP'
        const amount = Number(order?.total || 0)
        const amountText = `£${Number.isFinite(amount) ? amount.toFixed(2) : '0.00'} ${currency}`

        const r = await sendPaymentScreenshotReceivedEmail(customerEmail, {
          customerName,
          orderNumber,
          amountText,
        })

        console.log('[payment-capture/upload] screenshot received email result', {
          orderNumber,
          ok: !!r?.success,
          messageId: r?.messageId || null,
          error: r?.error || null,
        })
      } else {
        console.warn('[payment-capture/upload] screenshot received email skipped invalid email', {
          orderNumber: order?.order_number || null,
          to: customerEmail || null,
        })
      }
    } catch (emailErr) {
      console.error('[payment-capture/upload] screenshot received email failed (continuing)', emailErr?.message || emailErr)
    }



    const verifyProto = req.headers['x-forwarded-proto'] || req.protocol
    const verifyHost = req.get('host')
    const verifyOrigin = `${verifyProto}://${verifyHost}`
    const verifyBase = String(env('PAYMENT_VERIFICATION_BASE_URL', env('PUBLIC_API_BASE_URL', env('FRONTEND_URL', verifyOrigin))) || verifyOrigin).replace(/\/$/, '')

    const verifyUrl = `${verifyBase}/api/payment-verification/verify`



    const verifyRes = await fetchJsonWithTimeout(verifyUrl, {

      method: 'POST',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ order_number: order.order_number, screenshot_filename: newFilename }),

    })



    if (!verifyRes.ok) {

      console.error('[payment-capture/upload] verification request failed (continuing as pending)', {
        status: verifyRes.status,
        error: verifyRes?.data?.error || null,
        verifyUrl,
        orderNumber: order?.order_number,
      })

      // Do not fail the customer upload flow if the verification service is temporarily unavailable.
      // The admin can still manually review the screenshot from the order record.
      return res.json({
        ok: true,
        screenshotUrl,
        screenshotFilename: newFilename,
        verification: verifyRes.data || null,
        verification_error: verifyRes?.data?.error || `Verification request failed (${verifyRes.status})`,
        payment_status: 'pending',
      })

    }



    const decisionRaw = String(verifyRes?.data?.verdict?.decision || '').trim().toLowerCase()

    const paymentStatus = decisionRaw === 'approved' ? 'received' : 'rejected'



    let rejectionReason = null

    if (paymentStatus === 'rejected') {

      const reasons = verifyRes?.data?.verdict?.reasons

      const list = Array.isArray(reasons) ? reasons : []

      if (list.includes('amount_mismatch')) rejectionReason = 'Amount does not match the order total.'

      else if (list.includes('payee_missing_or_mismatch')) rejectionReason = 'Bank account name does not match.'

      else if (list.includes('sort_code_not_found') || list.includes('account_number_not_found')) {

        rejectionReason = 'Bank details not found in the screenshot.'

      } else if (list.includes('low_ocr_confidence')) rejectionReason = 'Screenshot is unclear or unreadable.'

      else if (list.includes('status_keyword_missing')) rejectionReason = 'Payment status not clearly visible in screenshot.'

      else if (list.length) rejectionReason = `Verification failed: ${list.join(', ')}`

      else rejectionReason = 'Payment verification failed.'

    }



    const conn2 = await pool.getConnection()

    try {

      await conn2.beginTransaction()

      if (paymentStatus === 'received') {
        try {
          await applyAvailableCreditsToOrder(conn2, order.order_number, { source: 'order_apply_manual', allowUpdatePaymentAmount: false })
        } catch {
          // ignore credit failures in upload flow
        }

        try {
          await grantAffiliateRewardForOrder(conn2, order.order_number, { rewardAmount: 40 })
        } catch {
          // ignore affiliate reward failures in upload flow
        }
      }

      const nextOrderStatus = paymentStatus === 'received' ? 'paid' : (String(order?.status || '').trim() || 'pending')
      const rejectionValue = paymentStatus === 'rejected' ? (rejectionReason || 'Payment verification failed.') : null
      const bankValue = paymentStatus === 'received' ? 'ibalticx' : null

      const tryUpdateOrders = async (sql, params) => {
        try {
          await conn2.execute(sql, params)
          return true
        } catch (e) {
          const msg = String(e?.message || e)
          if (/unknown column/i.test(msg) || /ER_BAD_FIELD_ERROR/i.test(String(e?.code || ''))) return false
          throw e
        }
      }

      // Prefer updating all relevant columns, but fall back gracefully if live DB schema is missing optional columns.
      let updated = await tryUpdateOrders(
        `UPDATE orders
           SET status = ?, payment_status = ?, payment_rejection_reason = ?, bank_account_used = ?, updated_at = CURRENT_TIMESTAMP
         WHERE order_number = ?
         LIMIT 1`,
        [nextOrderStatus, paymentStatus, rejectionValue, bankValue, order.order_number]
      )

      if (!updated) {
        updated = await tryUpdateOrders(
          `UPDATE orders
             SET status = ?, payment_status = ?, payment_rejection_reason = ?, updated_at = CURRENT_TIMESTAMP
           WHERE order_number = ?
           LIMIT 1`,
          [nextOrderStatus, paymentStatus, rejectionValue, order.order_number]
        )
      }

      if (!updated) {
        updated = await tryUpdateOrders(
          `UPDATE orders
             SET status = ?, payment_status = ?, updated_at = CURRENT_TIMESTAMP
           WHERE order_number = ?
           LIMIT 1`,
          [nextOrderStatus, paymentStatus, order.order_number]
        )
      }

      if (!updated) {
        await conn2.execute(
          `UPDATE orders
             SET payment_status = ?, updated_at = CURRENT_TIMESTAMP
           WHERE order_number = ?
           LIMIT 1`,
          [paymentStatus, order.order_number]
        )
      }

      // Best-effort: payments table may differ across environments; do not allow it to rollback the core order status update.
      try {
        await conn2.execute(
          `UPDATE payments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?`,
          [paymentStatus, order.id]
        )
      } catch (payErr) {
        const msg = String(payErr?.message || payErr)
        console.error('[payment-capture/upload] failed to update payments table (continuing)', msg)
        try {
          await conn2.execute(
            `UPDATE payments SET status = ? WHERE order_id = ?`,
            [paymentStatus, order.id]
          )
        } catch (payErr2) {
          console.error('[payment-capture/upload] failed to update payments table (fallback) (continuing)', String(payErr2?.message || payErr2))
        }
      }



      // Only mark the token as used after we have a verification verdict and persisted the payment status.

      await conn2.execute(

        'UPDATE payment_capture_requests SET used_at = ? WHERE id = ? LIMIT 1',

        [nowMysqlDatetime(), out.request.id]

      )



      await conn2.commit()

    } catch (e) {

      try {

        await conn2.rollback()

      } catch {

        // ignore

      }

      return res.status(500).json({ ok: false, error: e?.message || 'Failed to update payment status', verification: verifyRes.data })

    } finally {

      conn2.release()

    }



    // Fire-and-forget: email failures should not break the upload flow.

    try {

      const customerEmail = String(order?.customer_email || '').trim()

      const customerName = String(order?.customer_name || '').trim() || 'Customer'

      const orderNumber = String(order?.order_number || '').trim()

      const amount = Number(order?.total || 0)

      const currency = String(order?.currency || 'GBP')



      console.log('[payment-capture/upload] payment status email: start', {

        orderNumber,

        to: customerEmail,

        paymentStatus,

      })



      if (customerEmail && customerEmail.includes('@')) {

        if (paymentStatus === 'received') {

          const r = await sendPaymentSuccessfulEmail(customerEmail, {

            customerName,

            orderNumber,

            amount: Number.isFinite(amount) ? amount : 0,

            currency,

          })

          console.log('[payment-capture/upload] payment status email: success template result', {

            orderNumber,

            ok: !!r?.success,

            messageId: r?.messageId || null,

            error: r?.error || null,

          })



          try {

            const toDate = (value) => {

              if (!value) return null

              if (value instanceof Date) return value

              const d = new Date(value)

              return Number.isNaN(d.getTime()) ? null : d

            }



            const [payRows] = await pool.execute(

              `SELECT COALESCE(updated_at, created_at) AS payment_date

               FROM payments

               WHERE order_id = ?

                 AND LOWER(status) IN ('received', 'paid', 'success', 'succeeded', 'completed')

               ORDER BY COALESCE(updated_at, created_at) DESC

               LIMIT 1`,

              [Number(order.id)]

            )

            const payList = Array.isArray(payRows) ? payRows : []

            const paymentDate = payList.length ? toDate(payList[0]?.payment_date) : null

            if (!paymentDate) throw new Error('No successful payment date found for this order')



            const invoiceDate = new Intl.DateTimeFormat('en-GB', {

              day: '2-digit',

              month: 'short',

              year: 'numeric',

            }).format(paymentDate || new Date())



            const invoiceNumberRaw = orderNumber ? `INV-${orderNumber}` : `INV-${Date.now()}`

            const invoiceNumber = String(invoiceNumberRaw)

              .replace(/^INV-ALU-/i, 'INV-')

              .replace(/^INV-ALU/i, 'INV-')

            const invoiceTotal = Number.isFinite(amount) ? amount : 0



            const customerDisplayName = String(order?.customer_name || '').trim() || 'Customer'

            const customerPhone = String(order?.customer_phone || '').trim()

            const customerAddressLine1 = String(order?.shipping_address || '').trim()

            const customerAddressLine2 = [order?.shipping_city, order?.shipping_zip, order?.shipping_country]

              .map((v) => String(v || '').trim())

              .filter(Boolean)

              .join(', ')



            let orderItems = []

            try {

              const [itemRows] = await pool.execute(

                'SELECT name, sku, quantity, unit_price FROM order_items WHERE order_id = ? ORDER BY id ASC',

                [order.id]

              )

              orderItems = Array.isArray(itemRows) ? itemRows : []

            } catch {

              orderItems = []

            }



            const promoDiscountPercent = Number(order?.promo_discount_percent || 0)

            const masked = buildHasInvoiceMaskedItems({

              orderItems,

              promoDiscountPercent,

              expectedTotal: invoiceTotal,

            })



            const promoCode = String(order?.promo_code || '').trim()

            const discountAmount = Number(order?.discount_amount || 0)



            const invoicePayload = {

              invoiceDate,

              invoiceNumber,

              billToName: customerDisplayName,

              billToAddressLine1: customerAddressLine1,

              billToAddressLine2: customerAddressLine2,

              billToNumber: customerPhone,

              items: masked.items,

              subtotal: masked.subtotal,

              total: masked.total,

              promoCode: promoCode && promoCode !== '-' ? promoCode : '',

              promoDiscountPercent: Number.isFinite(promoDiscountPercent) ? promoDiscountPercent : 0,

              discountAmount: Number.isFinite(discountAmount) ? discountAmount : 0,

              bank: {

                bankName: '1066 Detailing Ltd',

                bankAddress: '',

                accountNumber: '46672542',

                sortCode: '60-83-82',

                beneficiaryName: '1066 Detailing Ltd',

                reference: 'Beauty',

              },

            }



            console.log('[payment-capture/upload] HAS invoice email skipped (disabled)', {

              orderNumber,

              invoiceNumber,

            })

          } catch (acctErr) {

            console.error('[payment-capture/upload] HAS invoice email failed', acctErr?.message || acctErr)

          }

        } else {

          let retryLink = ''

          try {

            const rawToken = randomToken()

            const tokenHash = sha256Hex(rawToken)

            const createdAt = nowMysqlDatetime()

            const expiresAt = addHoursMysql(24)



            await pool.execute(

              `INSERT INTO payment_capture_requests (order_id, email, token_hash, expires_at, used_at, created_at)

                VALUES (?, ?, ?, ?, NULL, ?)`,

              [Number(order.id), customerEmail, tokenHash, expiresAt, createdAt]

            )



            const publicProto = req.headers['x-forwarded-proto'] || req.protocol
            const publicHost = req.get('host')
            const publicOrigin = `${publicProto}://${publicHost}`
            const publicBase = String(PUBLIC_API_BASE_URL || env('PUBLIC_API_BASE_URL', env('FRONTEND_URL', publicOrigin)) || publicOrigin).replace(/\/$/, '')

            retryLink = `${publicBase}/checkout/payment?token=${encodeURIComponent(rawToken)}`

          } catch (linkErr) {

            console.error('[payment-capture/upload] failed to create retry payment link', linkErr?.message || linkErr)

            retryLink = ''

          }



          const r = await sendPaymentDeclinedEmail(customerEmail, {

            customerName,

            orderNumber,

            reason: rejectionReason || 'Payment verification failed.',

            retryLink,

          })

          console.log('[payment-capture/upload] payment status email: declined template result', {

            orderNumber,

            ok: !!r?.success,

            messageId: r?.messageId || null,

            error: r?.error || null,

          })

        }

      } else {

        console.warn('[payment-capture/upload] payment status email: skipped invalid email', {

          orderNumber,

          to: customerEmail,

        })

      }

    } catch (emailErr) {

      console.error('[payment-capture/upload] payment status email failed', emailErr?.message || emailErr)

    }



    return res.json({

      ok: true,

      screenshotUrl,

      screenshotFilename: newFilename,

      verification: verifyRes.data,

      payment_status: paymentStatus,

    })

  } catch (e) {

    if (connection) {

      try {

        await connection.rollback()

      } catch {

        // ignore

      }

    }

    return res.status(500).json({ ok: false, error: e?.message || 'Upload failed' })

  } finally {

    if (connection) connection.release()

  }

})



// Create order from checkout payload (supports JSON or multipart with paymentScreenshot)

app.post(['/api/user-orders', '/api/user-orders/'], upload.single('paymentScreenshot'), async (req, res) => {

  let connection

  try {

    const payload = req.body || {}



    // If multipart had a file, compute URL fields.

    if (req.file) {

      const proto = req.headers['x-forwarded-proto'] || req.protocol

      const host = req.get('host')

      const base = PUBLIC_BASE_URL || `${proto}://${host}`



      payload.screenshotFilename = payload.screenshotFilename || req.file.filename

      payload.screenshotUrl = payload.screenshotUrl || `${base}/uploads/${encodeURIComponent(req.file.filename)}`



    }



    connection = await pool.getConnection()

    await connection.beginTransaction()



    const out = await persistOrderFromCheckout(connection, payload, { providerId: payload.providerId })



    let paymentLink = null

    let paymentCaptureRequestId = null

    const emailDebug = {

      paymentLinkCreated: false,

      orderConfirmation: { attempted: false, ok: false, error: null },

      paymentCapture: { attempted: false, ok: false, error: null },

    }



    const isKlymeCheckout = isKlymeCheckoutPayload(payload, { providerId: payload.providerId })



    let processorEnabled = await isProcessorEnabledOrder({ orderId: out?.orderId, payload })

    const rawPaymentMethod = String(
      payload?.payment_method || payload?.paymentMethod || payload?.provider || payload?.payment_provider || ''
    )
      .trim()
      .toLowerCase()

    const forceManualReserveFlow = rawPaymentMethod === 'manual'

    if (forceManualReserveFlow && processorEnabled) {
      console.log('[user-orders] reserve-slot/manual order: overriding processorEnabled for payment capture flow', {
        orderId: out?.orderId,
        orderNumber: out?.orderNumber,
        rawPaymentMethod,
      })
      processorEnabled = false
    }



    const isSchemaError = (err) => {

      const code = String(err?.code || '').toUpperCase()

      const msg = String(err?.message || '')

      return (

        code === 'ER_NO_SUCH_TABLE' ||

        code === 'ER_BAD_FIELD_ERROR' ||

        /payment_capture_requests/i.test(msg)

      )

    }



    const safeEnsurePaymentCaptureSchema = async () => {

      try {

        await ensurePaymentCaptureTable()

      } catch (e) {

        console.error('[user-orders] ensurePaymentCaptureTable failed', e?.message || e)

      }

      try {

        await ensurePaymentCaptureEmailTrackingColumns()

      } catch (e) {

        console.error('[user-orders] ensurePaymentCaptureEmailTrackingColumns failed', e?.message || e)

      }

    }



    if (isKlymeCheckout || processorEnabled) {

      paymentLink = null

      paymentCaptureRequestId = null

      emailDebug.paymentLinkCreated = false

    } else {

      try {

        const orderId = Number(out?.orderId)

        if (Number.isFinite(orderId) && orderId > 0) {

          let existingRows

          try {

            ;[existingRows] = await connection.execute(

              `SELECT id, expires_at, used_at, created_at, email_sent_at, email_send_error

               FROM payment_capture_requests

               WHERE order_id = ?

               ORDER BY created_at DESC

               LIMIT 1

               FOR UPDATE`,

              [orderId]

            )

          } catch (selectErr) {

            if (isSchemaError(selectErr)) {

              console.warn('[user-orders] payment_capture_requests select failed, attempting schema ensure + retry', {

                code: selectErr?.code || null,

                message: selectErr?.message || String(selectErr),

              })

              await safeEnsurePaymentCaptureSchema()

                ;[existingRows] = await connection.execute(

                  `SELECT id, expires_at, used_at, created_at, email_sent_at, email_send_error

                 FROM payment_capture_requests

                 WHERE order_id = ?

                 ORDER BY created_at DESC

                 LIMIT 1

                 FOR UPDATE`,

                  [orderId]

                )

            } else {

              throw selectErr

            }

          }



          const existing = Array.isArray(existingRows) && existingRows[0] ? existingRows[0] : null

          const existingUsedAt = existing?.used_at ? new Date(existing.used_at) : null

          const existingExpiresAt = existing?.expires_at ? new Date(existing.expires_at) : null

          const existingCreatedAt = existing?.created_at ? new Date(existing.created_at) : null

          const existingEmailSentAt = existing?.email_sent_at ? new Date(existing.email_sent_at) : null



          const isExistingUnused = !existingUsedAt || Number.isNaN(existingUsedAt.getTime())

          const isExistingUnexpired =

            !!existingExpiresAt && !Number.isNaN(existingExpiresAt.getTime()) && existingExpiresAt.getTime() > Date.now()

          const isRecentExisting =

            !!existingCreatedAt && !Number.isNaN(existingCreatedAt.getTime()) && Date.now() - existingCreatedAt.getTime() < 2 * 60 * 1000

          const isExistingEmailAlreadySent = !!existingEmailSentAt && !Number.isNaN(existingEmailSentAt.getTime())

          const existingSendErrored = !!String(existing?.email_send_error || '').trim()



          // Idempotency guard: if a token was just generated and emailed successfully,

          // do NOT generate another token/email for duplicate submissions.

          if (existing && isExistingUnused && isExistingUnexpired && isRecentExisting && isExistingEmailAlreadySent && !existingSendErrored) {

            paymentLink = null

            paymentCaptureRequestId = Number(existing.id)

            emailDebug.paymentLinkCreated = false

          } else {

            const rawToken = randomToken()

            const tokenHash = sha256Hex(rawToken)

            const createdAt = nowMysqlDatetime()

            const expiresAt = addHoursMysql(24)



            let ins

            try {

              ;[ins] = await connection.execute(

                `INSERT INTO payment_capture_requests (order_id, email, token_hash, expires_at, used_at, email_sent_at, email_send_error, created_at)

                  VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,

                [orderId, String(payload.email || '').trim().toLowerCase(), tokenHash, expiresAt, createdAt]

              )

            } catch (insertErr) {

              if (isSchemaError(insertErr)) {

                console.warn('[user-orders] payment_capture_requests insert failed, attempting schema ensure + retry', {

                  code: insertErr?.code || null,

                  message: insertErr?.message || String(insertErr),

                })

                await safeEnsurePaymentCaptureSchema()

                  ;[ins] = await connection.execute(

                    `INSERT INTO payment_capture_requests (order_id, email, token_hash, expires_at, used_at, email_sent_at, email_send_error, created_at)

                    VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,

                    [orderId, String(payload.email || '').trim().toLowerCase(), tokenHash, expiresAt, createdAt]

                  )

              } else {

                throw insertErr

              }

            }



            paymentCaptureRequestId = Number(ins?.insertId)

            const publicBase = (PUBLIC_API_BASE_URL || 'https://alluvi.org').replace(/\/$/, '')

            paymentLink = `${publicBase}/checkout/payment?token=${encodeURIComponent(rawToken)}`

            emailDebug.paymentLinkCreated = true

          }

        }

      } catch (tokenErr) {

        console.error('[user-orders] Failed to create payment token:', tokenErr?.message || tokenErr)

        paymentLink = null

        paymentCaptureRequestId = null

        emailDebug.paymentLinkCreated = false

      }

    }



    await connection.commit()



    try {

      const customerName = `${String(payload.firstName || '').trim()} ${String(payload.lastName || '').trim()}`.trim() || 'Customer'

      const orderNumber = String(payload.orderId || payload.orderNumber || '').trim()

      const totalNumber = Number(payload.total)



      const customerEmail = String(payload.email || '').trim()

      if (customerEmail && customerEmail.includes('@') && orderNumber) {

        const rawPaymentMethodForEmails = String(
          payload?.payment_method || payload?.paymentMethod || payload?.provider || payload?.payment_provider || ''
        )
          .trim()
          .toLowerCase()

        if (rawPaymentMethodForEmails === 'manual') {
          console.log('[user-orders] reserve-slot/manual emails path active (build 2026-03-11)', { orderNumber, to: customerEmail })
        }

        const isAabanPayTestCheckout = (() => {
          try {
            const itemsArray = Array.isArray(payload?.itemsArray)
              ? payload.itemsArray
              : (Array.isArray(payload?.items) ? payload.items : [])
            for (const it of itemsArray) {
              const pid = String(it?.productId || it?.id || '').trim()
              if (pid === '32') return true
            }
            return false
          } catch {
            return false
          }
        })()

        if (isAabanPayTestCheckout && rawPaymentMethodForEmails !== 'manual') {
          console.log('[user-orders] post-checkout emails: skipped for AabanPay test product', { orderNumber, to: customerEmail })
          return res.json({ success: true, ...out, email_debug: { ...emailDebug, skipped: 'aabanpay_test_product' } })
        }

        console.log('[user-orders] post-checkout emails: start', {

          orderNumber,

          to: customerEmail,

          hasPaymentLink: !!paymentLink,

          isKlymeCheckout,

        })

        if (isKlymeCheckout || processorEnabled) {

          try {

            const trackUrl = `${(PUBLIC_API_BASE_URL || 'https://www.alluvi.store').replace(/\/$/, '')}/track-order`

            console.log('[user-orders] payment_processor order; will still send emails', {

              orderNumber,

              to: customerEmail,

              trackUrl,

              isKlymeCheckout,

            })

          } catch (e) {

            console.error('[user-orders] payment_processor log failed', e?.message || e)

          }

      



        // Brand-themed confirmation: if the order came from one of the white-label
        // storefronts (matched by request Origin), send its themed email via Resend.
        // Falls back to the generic Alluvi confirmation when no storefront matches.
        let brandedOk = false
        try {
          const b = await sendBrandedOrderConfirmation({ req, to: customerEmail, payload, orderNumber, customerName })
          brandedOk = b?.success === true
          console.log('[user-orders] branded order email', { orderNumber, to: customerEmail, ...b })
        } catch (e) {
          console.error('[user-orders] branded order email failed (continuing)', e?.message || String(e))
        }

        if (!brandedOk) try {
          const r = await sendOrderConfirmationEmail({
            customerEmail,
            customerName,
            orderNumber,
            total: Number.isFinite(totalNumber) ? Number(totalNumber.toFixed(2)) : undefined,
            shippingAddress: String(payload.address || payload.shippingAddress || '').trim(),
            shippingCity: String(payload.city || payload.shippingCity || '').trim(),
            shippingZip: String(payload.postcode || payload.shippingZip || '').trim(),
            shippingCountry: String(payload.country || payload.shippingCountry || '').trim(),
          })
          console.log('[user-orders] order confirmation email result', {
            orderNumber,
            ok: !!r?.success,
            messageId: r?.messageId || null,
            error: r?.error || null,
          })
        } catch (e) {
          console.error('[user-orders] order confirmation email failed (continuing)', e?.message || String(e))
        }

        if (paymentLink) {
          try {
            const trackUrl = `${(PUBLIC_API_BASE_URL || 'https://alluvi.org').replace(/\/$/, '')}/track-order`
            const r = await sendPaymentReminderEmail(customerEmail, {
              customerName,
              orderNumber,
              paymentLink,
              trackUrl,
            })
            console.log('[user-orders] payment link email result', {
              orderNumber,
              ok: !!r?.success,
              messageId: r?.messageId || null,
              error: r?.error || null,
            })

            if (paymentCaptureRequestId && r?.success) {
              try {
                await connection.execute(
                  'UPDATE payment_capture_requests SET email_sent_at = ?, email_send_error = NULL WHERE id = ? LIMIT 1',
                  [nowMysqlDatetime(), Number(paymentCaptureRequestId)]
                )
              } catch (e) {
                console.error('[user-orders] failed to persist payment_capture_requests.email_sent_at (continuing)', e?.message || String(e))
              }
            }
          } catch (e) {
            const errMsg = String(e?.message || e)
            console.error('[user-orders] payment link email failed (continuing)', errMsg)
            if (paymentCaptureRequestId) {
              try {
                await connection.execute(
                  'UPDATE payment_capture_requests SET email_send_error = ? WHERE id = ? LIMIT 1',
                  [errMsg.slice(0, 255), Number(paymentCaptureRequestId)]
                )
              } catch (e2) {
                console.error('[user-orders] failed to persist payment_capture_requests.email_send_error (continuing)', e2?.message || String(e2))
              }
            }
          }
        } else {
          console.warn('[user-orders] payment link email skipped (missing paymentLink)', { orderNumber, to: customerEmail })
        }

      }

    }

    } catch (emailErr) {

      console.error('[user-orders] post-checkout emails failed', emailErr?.message || emailErr)

    }



    return res.json({ success: true, ...out, email_debug: emailDebug })

  } catch (e) {

    if (connection) {

      try {

        await connection.rollback()

      } catch {

        // ignore

      }

    }

    if (String(e?.code || '') === 'CUSTOMER_BLACKLISTED') {

      return res.status(403).json({ success: false, error: e?.message || 'Customer is blacklisted' })

    }

    return res.status(500).json({ success: false, error: e?.message || String(e) })

  } finally {

    if (connection) connection.release()

  }

})



// Read: list orders by email (for user tracking)

app.get('/api/user-orders/by-email', async (req, res) => {

  try {

    const email = String(req.query?.email || '').trim().toLowerCase()

    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required' })



    const [rows] = await pool.execute(

      'SELECT * FROM orders WHERE LOWER(TRIM(customer_email)) = ? ORDER BY created_at DESC LIMIT 200',

      [email]

    )



    return res.json({ orders: Array.isArray(rows) ? rows : [] })

  } catch (e) {

    return res.status(500).json({ error: e?.message || 'Failed to fetch orders' })

  }

})



// Read: get a full order (order + items + payments) by order number

app.get('/api/user-orders/:orderNumber', async (req, res) => {

  try {

    const orderNumber = String(req.params.orderNumber || '').trim()

    if (!orderNumber) return res.status(400).json({ error: 'orderNumber is required' })



    const [ordersRows] = await pool.execute('SELECT * FROM orders WHERE order_number = ? LIMIT 1', [orderNumber])

    const orders = Array.isArray(ordersRows) ? ordersRows : []

    if (!orders.length) return res.status(404).json({ error: 'Order not found' })



    const orderId = orders[0].id

    const [itemsRows] = await pool.execute('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [orderId])

    const [paymentsRows] = await pool.execute('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC', [orderId])



    return res.json({ order: orders[0], items: Array.isArray(itemsRows) ? itemsRows : [], payments: Array.isArray(paymentsRows) ? paymentsRows : [] })

  } catch (e) {

    return res.status(500).json({ error: e?.message || 'Failed to fetch order' })

  }

})



// Update: allow updating limited fields for user flow (status/payment_status/tracking_number)

app.put('/api/user-orders/:orderNumber', async (req, res) => {

  try {

    const orderNumber = String(req.params.orderNumber || '').trim()

    if (!orderNumber) return res.status(400).json({ error: 'orderNumber is required' })



    const { status, payment_status, tracking_number } = req.body || {}



    const updates = []

    const values = []



    if (status !== undefined) {

      updates.push('status = ?')

      values.push(String(status))

    }

    if (payment_status !== undefined) {

      updates.push('payment_status = ?')

      values.push(String(payment_status))

    }

    if (tracking_number !== undefined) {

      updates.push('tracking_number = ?')

      values.push(String(tracking_number))

    }



    if (!updates.length) return res.status(400).json({ error: 'No updatable fields provided' })



    values.push(orderNumber)

    const [result] = await pool.execute(

      `UPDATE orders SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE order_number = ? LIMIT 1`,

      values

    )



    const affected = result?.affectedRows || 0

    if (!affected) return res.status(404).json({ error: 'Order not found' })



    return res.json({ success: true })

  } catch (e) {

    return res.status(500).json({ error: e?.message || 'Failed to update order' })

  }

})



// Delete: delete order by order number (expects cascades for items/payments)

app.delete('/api/user-orders/:orderNumber', async (req, res) => {

  try {

    const orderNumber = String(req.params.orderNumber || '').trim()

    if (!orderNumber) return res.status(400).json({ error: 'orderNumber is required' })



    const [result] = await pool.execute('DELETE FROM orders WHERE order_number = ? LIMIT 1', [orderNumber])

    const affected = result?.affectedRows || 0

    if (!affected) return res.status(404).json({ error: 'Order not found' })



    return res.json({ success: true })

  } catch (e) {

    return res.status(500).json({ error: e?.message || 'Failed to delete order' })

  }

})



// =====================================================

//   USER AUTHENTICATION ENDPOINTS

// =====================================================



// User Registration - Updates existing users if email already exists

app.post('/api/auth/register', async (req, res) => {

  const { name, email, password, date_of_birth, nationality, country_of_residence } = req.body



  if (!name || !email || !password) {

    return res.status(400).json({ error: 'Name, email and password are required' })

  }



  if (!date_of_birth || !nationality || !country_of_residence) {

    return res.status(400).json({ error: 'Date of birth, nationality and country of residence are required' })

  }



  try {

    const hashedPassword = await bcrypt.hash(password, 10)



    // Check if user already exists

    const [existingUsers] = await pool.execute('SELECT id FROM users WHERE email = ?', [email])



    let userId



    if (existingUsers.length > 0) {

      // User exists - update their information

      userId = existingUsers[0].id

      await pool.execute(

        'UPDATE users SET name = ?, password_hash = ?, date_of_birth = ?, nationality = ?, country_of_residence = ?, role = ?, updated_at = NOW() WHERE id = ?',

        [name, hashedPassword, date_of_birth, nationality, country_of_residence, 'user', userId]

      )

    } else {

      // New user - insert

      const [result] = await pool.execute(

        'INSERT INTO users (name, email, password_hash, date_of_birth, nationality, country_of_residence, role) VALUES (?, ?, ?, ?, ?, ?, ?)',

        [name, email, hashedPassword, date_of_birth, nationality, country_of_residence, 'user']

      )

      userId = result.insertId

    }



    const [userRows] = await pool.execute(

      'SELECT id, name, email, phone, date_of_birth, nationality, country_of_residence, role FROM users WHERE id = ?',

      [userId]

    )



    const user = userRows[0]

    const token = jwt.sign(

      { id: user.id, email: user.email, role: user.role },

      JWT_SECRET,

      { expiresIn: '30d' }

    )



    await pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [userId])



    res.status(201).json({

      success: true,

      token,

      user: {

        id: user.id,

        name: user.name,

        email: user.email,

        phone: user.phone,

        date_of_birth: user.date_of_birth,

        nationality: user.nationality,

        country_of_residence: user.country_of_residence,

        role: user.role

      }

    })

  } catch (err) {

    console.error('Registration error:', err)

    res.status(500).json({ error: 'Registration failed' })

  }

})



// User Login

app.post('/api/auth/login', async (req, res) => {

  const { email, password } = req.body



  if (!email || !password) {

    return res.status(400).json({ error: 'Email and password are required' })

  }



  try {

    const startedAt = Date.now()

    const dbTimeoutMs = envInt('AUTH_DB_TIMEOUT_MS', 12000)

    const [rows] = await withTimeout(

      pool.execute('SELECT * FROM users WHERE email = ? LIMIT 1', [email]),

      dbTimeoutMs,

      'login_user_lookup'

    )

    const user = rows[0]



    if (!user) {

      return res.status(401).json({ error: 'Invalid credentials' })

    }



    const isValidPassword = await withTimeout(

      bcrypt.compare(password, user.password_hash),

      envInt('AUTH_BCRYPT_TIMEOUT_MS', 8000),

      'login_password_check'

    )

    if (!isValidPassword) {

      return res.status(401).json({ error: 'Invalid credentials' })

    }



    const token = jwt.sign(

      { id: user.id, email: user.email, role: user.role },

      JWT_SECRET,

      { expiresIn: '30d' }

    )



    await withTimeout(

      pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]),

      dbTimeoutMs,

      'login_last_login_update'

    )

    console.log('[auth] login success in ms:', Date.now() - startedAt)



    res.json({

      success: true,

      token,

      user: {

        id: user.id,

        name: user.name,

        email: user.email,

        phone: user.phone,

        date_of_birth: user.date_of_birth,

        nationality: user.nationality,

        country_of_residence: user.country_of_residence,

        role: user.role

      }

    })

  } catch (err) {

    console.error('Login error:', err)

    if (String(err?.code || '').toUpperCase() === 'ETIMEDOUT') {

      return res.status(503).json({ error: 'Login temporarily unavailable. Please try again.' })

    }

    res.status(500).json({ error: 'Login failed' })

  }

})

// Get real client IP address endpoint
app.get('/api/client-ip', (req, res) => {
  try {
    console.log('[IP] Getting client IP address...');

    // Get client IP from various headers (supports Cloudflare, proxies, etc.)
    const getClientIp = () => {
      // Check for Cloudflare connecting IP
      const cfConnectingIp = req.headers['cf-connecting-ip'];
      if (cfConnectingIp) {
        console.log('[IP] Found Cloudflare Connecting IP:', cfConnectingIp);
        return cfConnectingIp;
      }

      // Check for True Client IP
      const trueClientIp = req.headers['true-client-ip'];
      if (trueClientIp) {
        console.log('[IP] Found True Client IP:', trueClientIp);
        return trueClientIp;
      }

      // Check for X-Real-IP
      const xRealIp = req.headers['x-real-ip'];
      if (xRealIp) {
        console.log('[IP] Found X-Real-IP:', xRealIp);
        return xRealIp;
      }

      // Check for X-Forwarded-For (take first IP)
      const xForwardedFor = req.headers['x-forwarded-for'];
      if (xForwardedFor) {
        const forwardedIps = String(xForwardedFor).split(',');
        const firstIp = forwardedIps[0].trim();
        console.log('[IP] Found X-Forwarded-For:', firstIp);
        return firstIp;
      }

      // Fallback to remote address
      const remoteAddr = req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip;
      console.log('[IP] Using remote address:', remoteAddr);
      return remoteAddr;
    };

    const clientIp = getClientIp();

    // Validate IP format
    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9])?[0-9])\.){3}(3[0-5]|2[0-4]|[0-1]?[0-9]?[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9])?[0-9])\.){3}(3[0-5]|2[0-4]|[0-1]?[0-9]?[0-9]))$/;

    const isValidIp = ipRegex.test(clientIp);

    if (!isValidIp) {
      console.warn('[IP] Invalid IP format detected:', clientIp);
      // Return a fallback IP if invalid
      return res.json({
        ip: '8.8.8.8', // Google DNS as fallback
        source: 'fallback',
        warning: 'Invalid IP format detected'
      });
    }

    console.log('[IP] Successfully retrieved client IP:', clientIp);

    res.json({
      ip: clientIp,
      source: 'server',
      headers: {
        'cf-connecting-ip': req.headers['cf-connecting-ip'],
        'true-client-ip': req.headers['true-client-ip'],
        'x-real-ip': req.headers['x-real-ip'],
        'x-forwarded-for': req.headers['x-forwarded-for'],
        'remote-address': req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip
      }
    });

  } catch (error) {
    console.error('[IP] Error getting client IP:', error);
    res.status(500).json({
      ip: '8.8.8.8', // Google DNS as fallback
      source: 'error',
      error: 'Failed to get client IP'
    });
  }
});

// Test endpoint for IP detection
app.get('/api/test-ip', (req, res) => {
  try {
    console.log('[TEST] Testing IP detection...');

    const getClientIp = () => {
      const cfConnectingIp = req.headers['cf-connecting-ip'];
      if (cfConnectingIp) return cfConnectingIp;

      const trueClientIp = req.headers['true-client-ip'];
      if (trueClientIp) return trueClientIp;

      const xRealIp = req.headers['x-real-ip'];
      if (xRealIp) return xRealIp;

      const xForwardedFor = req.headers['x-forwarded-for'];
      if (xForwardedFor) {
        const forwardedIps = String(xForwardedFor).split(',');
        return forwardedIps[0].trim();
      }

      return req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip;
    };

    const clientIp = getClientIp();

    res.json({
      success: true,
      clientIp: clientIp,
      timestamp: new Date().toISOString(),
      headers: {
        'cf-connecting-ip': req.headers['cf-connecting-ip'],
        'true-client-ip': req.headers['true-client-ip'],
        'x-real-ip': req.headers['x-real-ip'],
        'x-forwarded-for': req.headers['x-forwarded-for'],
        'remote-address': req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip,
        'user-agent': req.headers['user-agent']
      }
    });

  } catch (error) {
    console.error('[TEST] Error testing IP:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to test IP detection'
    });
  }
})

// Duplicate endpoints under /api/user-orders/* because production routing reliably forwards this prefix.
app.get('/api/user-orders/client-ip', (req, res) => {
  try {
    console.log('[IP] Getting client IP address...');

    const getClientIp = () => {
      const cfConnectingIp = req.headers['cf-connecting-ip'];
      if (cfConnectingIp) return cfConnectingIp;

      const trueClientIp = req.headers['true-client-ip'];
      if (trueClientIp) return trueClientIp;

      const xRealIp = req.headers['x-real-ip'];
      if (xRealIp) return xRealIp;

      const xForwardedFor = req.headers['x-forwarded-for'];
      if (xForwardedFor) {
        const forwardedIps = String(xForwardedFor).split(',');
        return forwardedIps[0].trim();
      }

      return req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip;
    };

    const clientIp = getClientIp();

    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9])?[0-9])\.){3}(3[0-5]|2[0-4]|[0-1]?[0-9]?[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9])?[0-9])\.){3}(3[0-5]|2[0-4]|[0-1]?[0-9]?[0-9]))$/;

    if (!ipRegex.test(clientIp)) {
      return res.json({ ip: '8.8.8.8', source: 'fallback', warning: 'Invalid IP format detected' });
    }

    return res.json({
      ip: clientIp,
      source: 'server',
      headers: {
        'cf-connecting-ip': req.headers['cf-connecting-ip'],
        'true-client-ip': req.headers['true-client-ip'],
        'x-real-ip': req.headers['x-real-ip'],
        'x-forwarded-for': req.headers['x-forwarded-for'],
        'remote-address': req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip,
      },
    });
  } catch (error) {
    console.error('[IP] Error getting client IP:', error);
    return res.status(500).json({ ip: '8.8.8.8', source: 'error', error: 'Failed to get client IP' });
  }
});

app.post('/api/user-orders/fengyu/check', fengyuProxy);

// Fengyu API proxy endpoint to avoid CORS issues
app.post('/api/fengyu/check', fengyuProxy);

app.get('/api/auth/verify', async (req, res) => {

  try {

    const header = String(req.headers?.authorization || '')

    const m = header.match(/^Bearer\s+(.+)$/i)

    const rawToken = m ? String(m[1] || '').trim() : ''

    if (!rawToken) return res.status(401).json({ error: 'Missing token' })



    let payload

    try {

      payload = jwt.verify(rawToken, JWT_SECRET)

    } catch {

      return res.status(401).json({ error: 'Invalid token' })

    }



    const userId = Number(payload?.id)

    const email = String(payload?.email || '').trim()

    if (!Number.isFinite(userId) || userId <= 0) return res.status(401).json({ error: 'Invalid token' })



    const [rows] = await pool.execute(

      'SELECT id, name, email, phone, date_of_birth, nationality, country_of_residence, role FROM users WHERE id = ? LIMIT 1',

      [userId]

    )

    const user = Array.isArray(rows) && rows[0] ? rows[0] : null

    if (!user) return res.status(401).json({ error: 'User not found' })

    if (email && String(user.email || '').trim().toLowerCase() !== email.toLowerCase()) {

      return res.status(401).json({ error: 'Invalid token' })

    }



    return res.json({ success: true, user })

  } catch (e) {

    return res.status(500).json({ error: e?.message || 'Verify failed' })

  }

})



// Forgot Password - Send reset email

app.post('/api/auth/forgot-password', async (req, res) => {

  const { email } = req.body



  if (!email) {

    return res.status(400).json({ error: 'Email is required' })

  }



  try {

    const [rows] = await pool.execute('SELECT id, name, email FROM users WHERE email = ?', [email])

    const user = rows[0]



    // Always return success even if user doesn't exist (security best practice)

    if (!user) {

      return res.json({ success: true, message: 'If an account exists with this email, a password reset link has been sent.' })

    }



    // Generate secure random token

    const resetToken = crypto.randomBytes(32).toString('hex')

    const expiresAt = new Date(Date.now() + 3600000) // 1 hour from now



    // Store token in database

    await pool.execute(

      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',

      [user.id, resetToken, expiresAt]

    )



    // Resolve which white-label storefront this request came from (by Origin/
    // Referer header, same lookup used for branded order confirmations) so the
    // reset link points at that site's own domain instead of a hardcoded one —
    // sending it to the wrong domain is what caused the reset link to 404.

    const theme = resolveBrandTheme(req, {}) || DEFAULT_THEME

    const frontendUrl = `https://${theme.domain}`

    const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`



    // Send via Resend so the email comes from that storefront's own domain
    // (orders@<domain>) instead of the shared Gmail inbox.

    const branded = await sendBrandedPasswordResetEmail({ req, to: user.email, resetLink, userName: user.name })

    if (!branded?.success) {

      console.warn('[forgot-password] branded send failed/skipped, falling back to SMTP', branded)

      // Fallback: same themed template, sent through the shared Gmail inbox
      // (can't send "from" an arbitrary domain over SMTP, only Resend can).

      const transporter = nodemailer.createTransport({

        host: 'smtp.gmail.com',

        port: 587,

        secure: false,

        auth: {

          user: env('EMAIL_USER'),

          pass: env('EMAIL_PASS'),

        },

      })



      await transporter.sendMail({

        from: `"${theme.brand}" <${env('EMAIL_USER')}>`,

        to: user.email,

        subject: `Reset Your ${theme.brand} Password`,

        html: renderPasswordResetEmailHtml(theme, { userName: user.name || 'there', resetLink }),

      })

    }



    res.json({ success: true, message: 'Password reset link has been sent to your email.' })

  } catch (err) {

    console.error('Forgot password error:', err)

    res.status(500).json({ error: 'Failed to process password reset request' })

  }

})



// Reset Password - Update password with token

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body

  if (!token || !password) {
    return res.status(400).json({ error: 'Token and password are required' })
  }


  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' })
  }



  try {

    // Find valid token

    const [tokenRows] = await pool.execute(
      'SELECT * FROM password_reset_tokens WHERE token = ? AND expires_at > NOW() AND used_at IS NULL',
      [token]

    )



    const resetToken = tokenRows[0]

    if (!resetToken) {
      return res.status(400).json({ error: 'Invalid or expired reset token' })
    }



    // Hash new password

    const hashedPassword = await bcrypt.hash(password, 10)
    // Update user password
    await pool.execute(
      'UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?',
      [hashedPassword, resetToken.user_id]

    )



    // Mark token as used

    await pool.execute(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?',
      [resetToken.id]
    )



    res.json({ success: true, message: 'Password has been reset successfully' })

  } catch (err) {

    console.error('Reset password error:', err)

    res.status(500).json({ error: 'Failed to reset password' })

  }

})



// =====================================================

// KLYME PAYMENT GATEWAY INTEGRATION

// =====================================================



function getActiveKlymeConfig() {

  const envName = String(KLYME_ENV || 'production').toLowerCase().trim()

  if (envName === 'sandbox' || envName === 'test') {

    return {

      envName: 'sandbox',

      merchantUuid: KLYME_SANDBOX_MERCHANT_UUID,

      username: KLYME_SANDBOX_API_USERNAME,

      password: KLYME_SANDBOX_API_PASSWORD,

      baseUrl: KLYME_SANDBOX_API_BASE_URL,

      baseUrls: KLYME_SANDBOX_API_BASE_URLS,

    }

  }



  return {

    envName: 'production',

    merchantUuid: KLYME_MERCHANT_UUID,

    username: KLYME_API_USERNAME,

    password: KLYME_API_PASSWORD,

    baseUrl: KLYME_API_BASE_URL,

    baseUrls: KLYME_API_BASE_URLS,

  }

}



function resolveKlymeBaseUrls(cfg = null) {

  const active = cfg || getActiveKlymeConfig()

  const configured = String(active.baseUrls || '')

    .split(',')

    .map((s) => s.trim())

    .filter(Boolean)



  const defaults = active.envName === 'sandbox'

    ? [

      'https://api-test.klyme.io/api/v1',

      'https://api.klyme.io/api/v1',

      'http://api.klyme.io/api/v1',

    ]

    : [

      'https://api.klyme.io/api/v1',

      'https://api-test.klyme.io/api/v1',

      'http://api.klyme.io/api/v1',

    ]



  const base = String(active.baseUrl || '').trim()

  const list = []

  // Prefer explicitly configured single baseUrl first (more likely to be correct)
  if (base) list.push(base)

  // Then any comma-separated baseUrls
  list.push(...configured)

  for (const d of defaults) list.push(d)



  // de-dupe, preserve order

  return [...new Set(list.map((x) => x.replace(/\/$/, '')))]

}



async function fetchWithTimeout(url, options, timeoutMs = 15000) {

  const controller = new AbortController()

  const t = setTimeout(() => controller.abort(), timeoutMs)

  try {

    const res = await fetch(url, { ...options, signal: controller.signal })

    return res

  } finally {

    clearTimeout(t)

  }

}



// Helper function to call Klyme API (tries multiple base URLs and payload formats)

async function callKlymeAPI(endpoint, method, body = null, opts = {}) {

  const cfg = opts?.klymeConfig || getActiveKlymeConfig()

  const authString = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')

  const baseUrls = resolveKlymeBaseUrls(cfg)



  const prefer = String(opts.prefer || 'json') // json | form

  const attempts = prefer === 'form' ? ['form', 'json'] : ['json', 'form']



  let lastErr = null

  for (const baseUrl of baseUrls) {

    for (const mode of attempts) {

      const url = `${baseUrl}${endpoint}`



      const headers = {

        'Authorization': `Basic ${authString}`,

      }



      const options = {

        method,

        headers,

      }



      if (method === 'POST' && body) {

        if (mode === 'json') {

          headers['Content-Type'] = 'application/json'

          options.body = JSON.stringify(body)

        } else {

          headers['Content-Type'] = 'application/x-www-form-urlencoded'

          const params = new URLSearchParams()

          Object.entries(body).forEach(([k, v]) => {

            if (v === undefined || v === null) return

            params.append(String(k), String(v))

          })

          options.body = params.toString()

        }

      }



      try {

        const response = await fetchWithTimeout(url, options, Number(opts.timeoutMs || 15000))

        const responseText = await response.text()

        let data = {}

        try {

          data = JSON.parse(responseText)

        } catch {

          // ignore

        }



        if (!response.ok) {

          console.error('[Klyme] Request URL:', url)

          if (options.body) console.error('[Klyme] Request body:', options.body)

          console.error('[Klyme] Response status:', response.status)

          console.error('[Klyme] Response body:', responseText)



          // If unauthorized on this host, try next host.

          if (response.status === 401) continue



          // Endpoint not found on this host (some environments differ) - try next host.

          if (response.status === 404) continue



          // If bad request due to content-type mismatch, try the other mode on same host.

          if (response.status === 400 || response.status === 415) continue

        }



        return { ok: response.ok, status: response.status, data, baseUrl, mode }

      } catch (e) {

        lastErr = e

        const msg = String(e?.message || e)

        console.error('[Klyme] Fetch error:', msg)

        // Try next base URL.

        continue

      }

    }

  }



  throw lastErr || new Error('Klyme request failed')

}

function deriveKlymeStatus(payload) {
  const directStatus = payload?.status
  const directCode = payload?.status_code || payload?.statusCode || payload?.statuscode
  const result = payload?.result || {}
  const status = directStatus ?? result?.status
  const statusCode = directCode ?? result?.statusCode ?? result?.status_code ?? result?.statuscode
  const description = payload?.description ?? result?.description
  const settlement = payload?.settlement ?? result?.settlement

  const sc = String(statusCode || '').toUpperCase().trim()
  if (sc) {
    const successCodes = new Set([
      'ACSP',
      'ACSC',
      'ACCP',
      'ACCC',
      'ACCEPTED',
      'COMPLETED',
      'SUCCESS',
      'SUCCEEDED',
      'PAID',
      'CAPTURED',
      'APPROVED',
      'VERIFIED',
      'RECEIVED',
      'SETTLED',
    ])
    const failedCodes = new Set([
      'RJCT',
      'REJECTED',
      'FAILED',
      'DECLINED',
      'CANCELLED',
      'CANCELED',
      'CANCEL',
      'EXPIRED',
      'TIMEOUT',
    ])
    const pendingCodes = new Set([
      'PDNG',
      'PENDING',
      'PROCESSING',
      'INPROGRESS',
      'IN_PROGRESS',
      'INITIATED',
    ])

    if (successCodes.has(sc)) return { status: 1, statusCode, description, settlement }
    if (failedCodes.has(sc)) return { status: 0, statusCode, description, settlement }
    if (pendingCodes.has(sc)) return { status: 2, statusCode, description, settlement }
  }



  // Normalize numeric status only if we couldn't classify by status_code.
  // Some Klyme payloads include a numeric status that is not authoritative.
  const n = Number(status)
  if (Number.isFinite(n)) {
    return { status: n, statusCode, description, settlement }
  }



  // Map description strings to numeric status

  const desc = String(description || '').toUpperCase().trim()

  if (desc === 'COMPLETED') return { status: 1, statusCode, description, settlement }

  if (desc === 'SUCCESS' || desc === 'SUCCEEDED' || desc === 'PAID') return { status: 1, statusCode, description, settlement }

  if (desc === 'FAILED') return { status: 0, statusCode, description, settlement }

  if (desc === 'REJECTED' || desc === 'DECLINED' || desc === 'CANCELLED' || desc === 'CANCELED') return { status: 0, statusCode, description, settlement }

  if (desc === 'PENDING') return { status: 2, statusCode, description, settlement }

  if (desc === 'PROCESSING' || desc === 'INPROGRESS' || desc === 'IN_PROGRESS') return { status: 2, statusCode, description, settlement }



  return { status: null, statusCode, description, settlement }
}


// ... (rest of the code remains the same)

async function getKlymePaymentStatus(uuid) {

  // Docs: GET /payments/status?uuid=...

  const endpoint = `/payments/status?uuid=${encodeURIComponent(String(uuid || '').trim())}`

  return await callKlymeAPI(endpoint, 'GET', null, { prefer: 'json', timeoutMs: 15000 })

}

const klymeRecheckInFlight = new Map()

async function recheckAndUpdateKlymeStatus(uuid, attempt = 0) {
  const maxAttempts = 8
  const delayMs = Math.min(60000, 3000 * Math.pow(2, attempt))

  try {
    const u = String(uuid || '').trim()
    if (!u) return

    let connection
    try {
      connection = await pool.getConnection()
      const [sessionRows] = await connection.execute(
        'SELECT session_id, order_id, status FROM payment_sessions WHERE session_id = ? LIMIT 1',
        [u]
      )
      const session = Array.isArray(sessionRows) && sessionRows[0] ? sessionRows[0] : null
      const current = String(session?.status || '').trim().toLowerCase()
      if (current === 'success' || current === 'failed') return

      const klymeRes = await getKlymePaymentStatus(u)
      const derived = deriveKlymeStatus(klymeRes?.data || {})
      const statusNum = derived.status

      if (!(statusNum === 1 || statusNum === 0 || statusNum === 2)) {
        if (attempt < maxAttempts) {
          setTimeout(() => {
            void recheckAndUpdateKlymeStatus(u, attempt + 1)
          }, delayMs)
        }
        return
      }

      if (statusNum === 2) {
        if (attempt < maxAttempts) {
          setTimeout(() => {
            void recheckAndUpdateKlymeStatus(u, attempt + 1)
          }, delayMs)
        }
        return
      }

      const sessionStatus = statusNum === 1 ? 'success' : 'failed'
      const paymentStatus = statusNum === 1 ? 'success' : 'failed'
      const orderStatus = statusNum === 1 ? 'processing' : 'pending'
      const orderPaymentStatus = statusNum === 1 ? 'received' : 'rejected'

      await connection.execute(
        'UPDATE payment_sessions SET status = ?, updated_at = NOW() WHERE session_id = ?',
        [sessionStatus, u]
      )

      await connection.execute(
        `UPDATE payments
         SET status = ?, final_status = ?, status_checked_at = NOW(), raw_response = ?, updated_at = NOW()
         WHERE provider = 'Klyme' AND provider_id = ?`,
        [paymentStatus, derived.statusCode || paymentStatus, JSON.stringify(klymeRes?.data || {}), u]
      )

      if (session?.order_id) {
        await connection.execute(
          'UPDATE orders SET status = ?, payment_status = ?, updated_at = NOW() WHERE id = ?',
          [orderStatus, orderPaymentStatus, session.order_id]
        )
        if (String(orderPaymentStatus || '').toLowerCase() === 'received') {
          try { await grantAffiliateRewardForOrderId(connection, session.order_id, { rewardAmount: 40 }) } catch (e) { console.error('[klyme/webhook] affiliate reward failed', e?.message || e) }
        }
      }
    } finally {
      if (connection) connection.release()
    }
  } catch (e) {
    if (attempt < maxAttempts) {
      setTimeout(() => {
        void recheckAndUpdateKlymeStatus(uuid, attempt + 1)
      }, delayMs)
    }
  }
}

function scheduleKlymeStatusRecheck(uuid) {
  const u = String(uuid || '').trim()
  if (!u) return
  if (klymeRecheckInFlight.has(u)) return
  klymeRecheckInFlight.set(u, Date.now())
  setTimeout(() => {
    klymeRecheckInFlight.delete(u)
    void recheckAndUpdateKlymeStatus(u, 0)
  }, 1500)
}



function decryptKlymeWebhookIfNeeded(body) {

  try {

    if (!body || typeof body !== 'object') return null

    const ivHex = body?.iv

    const dataHex = body?.data

    if (!ivHex || !dataHex) return null

    if (!KLYME_WEBHOOK_SECRET) return null



    const iv = Buffer.from(String(ivHex), 'hex')

    const encryptedText = Buffer.from(String(dataHex), 'hex')

    const decipher = crypto.createDecipheriv('aes-256-ctr', Buffer.from(KLYME_WEBHOOK_SECRET), iv)

    let decrypted = decipher.update(encryptedText)

    decrypted = Buffer.concat([decrypted, decipher.final()])

    const decryptedText = decrypted.toString('utf8')

    try {

      return JSON.parse(decryptedText)

    } catch {

      return { raw: decryptedText }

    }

  } catch (e) {

    console.error('[Klyme] Webhook decrypt failed:', e?.message || String(e))

    return null

  }

}



// POST /api/klyme/create-payment - Create Klyme payment authorization

app.post('/api/klyme/create-payment', async (req, res) => {

  let connection

  try {

    const { orderId, amount, currency = 'GBP' } = req.body



    const klymeCfg = getActiveKlymeConfig()

    try {

      console.log('[klyme/create-payment] using config', {

        envName: klymeCfg?.envName,

        hasMerchantUuid: !!klymeCfg?.merchantUuid,

        hasUsername: !!klymeCfg?.username,

        hasPassword: !!klymeCfg?.password,

        baseUrl: String(klymeCfg?.baseUrl || ''),

      })

    } catch {

      // ignore

    }

    if (!klymeCfg.merchantUuid || !klymeCfg.username || !klymeCfg.password) {

      return res.status(500).json({ ok: false, error: `Klyme credentials not configured (${klymeCfg.envName})` })

    }



    if (!orderId || !amount) {

      return res.status(400).json({ ok: false, error: 'Missing required fields: orderId, amount', klymeEnv: klymeCfg.envName })

    }



    connection = await pool.getConnection()



    // Get order from database

    const [orderRows] = await connection.execute(

      'SELECT * FROM orders WHERE order_number = ? LIMIT 1',

      [orderId]

    )



    if (!Array.isArray(orderRows) || orderRows.length === 0) {

      return res.status(404).json({ ok: false, error: 'Order not found', klymeEnv: klymeCfg.envName })

    }



    const order = orderRows[0]



    // Create redirect URL for success/failure

    const frontendUrl = env('FRONTEND_URL', 'https://alluvi.store')

    const redirectUrl = `${frontendUrl}/checkout/klyme-callback`



    // Apply credits at finalization moment: when initiating the Klyme payment.
    // This prevents deducting credits for draft/abandoned orders and ensures the payable amount is reduced.
    let payableAmount = Number(amount)
    try {
      const reserved = await reserveAvailableCreditsForOrder(connection, String(orderId || '').trim(), {
        source: 'order_reserve_klyme',
        allowUpdatePaymentAmount: true,
      })
      if (reserved?.ok && Number.isFinite(Number(reserved?.payableTotal))) {
        payableAmount = Number(reserved.payableTotal)
      }
    } catch {
      // ignore
    }

    // If credits fully cover the order, skip Klyme and finalize immediately.
    if (!Number.isFinite(payableAmount) || payableAmount < 0) payableAmount = 0
    if (payableAmount <= 0) {
      try {
        await applyAvailableCreditsToOrder(connection, String(orderId || '').trim(), {
          source: 'order_apply_credits_only',
          allowUpdatePaymentAmount: true,
        })
      } catch {
        // ignore
      }
      try {
        await connection.execute(
          'UPDATE orders SET status = ?, payment_status = ?, updated_at = NOW() WHERE id = ?',
          ['processing', 'received', order.id]
        )
        try { await grantAffiliateRewardForOrderId(connection, order.id, { rewardAmount: 40 }) } catch (e) { console.error('[klyme/alt] affiliate reward failed', e?.message || e) }
      } catch {
        // ignore
      }

      try {
        await connection.execute(
          `INSERT INTO payments (order_id, provider, provider_id, amount, currency, status, raw_response, created_at)
           VALUES (?, 'Credits', ?, ?, ?, 'success', NULL, NOW())
           ON DUPLICATE KEY UPDATE amount = VALUES(amount), currency = VALUES(currency), status = 'success', updated_at = NOW()`,
          [order.id, `CREDITS-${String(order.order_number || orderId)}`, 0, currency || 'GBP']
        )
      } catch {
        // ignore
      }

      return res.json({ ok: true, paidByCredits: true, orderId: order.order_number, klymeEnv: klymeCfg.envName })
    }

    // Call Klyme API to create payment authorization

    const klymeReference = stripAluToken(order.order_number || orderId || '')

    const klymeResponse = await callKlymeAPI('/payment-auth-requests', 'POST', {

      merchantUuid: klymeCfg.merchantUuid,

      amount: Number(payableAmount).toFixed(2),

      currency: currency || 'GBP',

      redirectUrl: redirectUrl,

      reference: String(klymeReference).slice(0, 64),

      email: String(order.customer_email || '').trim(),

      firstName: String(order.customer_name || '').trim().split(' ')[0] || '',

      surname: String(order.customer_name || '').trim().split(' ').slice(1).join(' ') || '',

      postcode: String(order.shipping_zip || '').trim() || undefined,

      country: 'GB',

      custom1: String(klymeReference).slice(0, 128),

    }, { prefer: 'json', timeoutMs: 15000, klymeConfig: klymeCfg })



    if (!klymeResponse.ok) {

      console.error('Klyme API error:', klymeResponse.data)

      return res.status(klymeResponse.status || 500).json({

        ok: false,

        error: klymeResponse.data?.error || 'Failed to create Klyme payment',

      })

    }



    const paymentUuid = klymeResponse.data?.uuid



    if (!paymentUuid) {

      return res.status(500).json({ ok: false, error: 'Klyme did not return payment UUID' })

    }



    // Store payment session in database

    await connection.execute(

      `INSERT INTO payment_sessions (

        session_id, order_id, payment_provider_id, customer_email, customer_name,

        order_data, payment_url, success_url, failure_url, status, created_at, expires_at

      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW(), DATE_ADD(NOW(), INTERVAL 1 HOUR))

      ON DUPLICATE KEY UPDATE

        payment_provider_id = VALUES(payment_provider_id),

        status = 'pending',

        updated_at = NOW()`,

      [

        paymentUuid,

        order.id,

        paymentUuid,

        order.customer_email,

        order.customer_name,

        JSON.stringify({ orderId: order.order_number, amount: Number(payableAmount).toFixed(2), currency }),

        redirectUrl,

        redirectUrl,

        redirectUrl,

      ]

    )



    // If this order contains Klyme-enabled products, send an immediate "complete your payment" email.

    try {

      const isKlymeEnabledOrder = await isProcessorEnabledOrder({ orderId: order.id, payload: null })

      if (isKlymeEnabledOrder) {

        const [sRows] = await connection.execute(

          'SELECT reminder_email_sent_at FROM payment_sessions WHERE session_id = ? LIMIT 1',

          [paymentUuid]

        )

        const sRow = Array.isArray(sRows) && sRows[0] ? sRows[0] : {}

        if (!sRow?.reminder_email_sent_at) {

          const customerEmail = String(order?.customer_email || '').trim()

          const customerName = String(order?.customer_name || '').trim() || 'Customer'

          const orderNumber = String(order?.order_number || '').trim()



          const publicBase = String(env('PUBLIC_API_BASE_URL', env('FRONTEND_URL', 'https://www.alluvi.store')) || 'https://www.alluvi.store').replace(/\/$/, '')

          const trackUrl = `${publicBase}/track-order`



          if (customerEmail && customerEmail.includes('@') && orderNumber) {

            console.log('[klyme/create-payment] payment_processor reminder email disabled; skipping send', {
              paymentUuid,
              orderNumber,
              to: customerEmail,
              paymentLink: trackUrl,
            })

            await connection.execute(

              'UPDATE payment_sessions SET reminder_email_sent_at = NOW() WHERE session_id = ? LIMIT 1',

              [paymentUuid]

            )

          } else {

            console.log('[klyme/create-payment] reminder email skipped (missing customerEmail/orderNumber)', {

              paymentUuid,

              hasCustomerEmail: !!customerEmail,

              hasOrderNumber: !!orderNumber,

            })

          }

        } else {

          console.log('[klyme/create-payment] reminder email already sent', {

            paymentUuid,

            orderId: order?.id,

            orderNumber: order?.order_number,

          })

        }

      }

    } catch (e) {

      console.error('[klyme/create-payment] reminder email failed', e?.message || e)

    }



    // Store in payments table

    await connection.execute(

      `INSERT INTO payments (order_id, provider, provider_id, amount, currency, status, raw_response, created_at)

       VALUES (?, 'Klyme', ?, ?, ?, 'pending', ?, NOW())

       ON DUPLICATE KEY UPDATE

         amount = VALUES(amount),

         currency = VALUES(currency),

         status = 'pending',

         updated_at = NOW()`,

      [order.id, paymentUuid, Number(payableAmount).toFixed(2), currency || 'GBP', JSON.stringify(klymeResponse.data)]

    )



    return res.json({

      ok: true,

      paymentUuid: paymentUuid,

      orderId: order.order_number,

      klymeEnv: klymeCfg.envName,

    })



  } catch (err) {

    console.error('Create Klyme payment error:', err)

    try {

      const klymeCfg = getActiveKlymeConfig()

      return res.status(500).json({ ok: false, error: err?.message || 'Failed to create payment', klymeEnv: klymeCfg.envName })

    } catch {

      return res.status(500).json({ ok: false, error: err?.message || 'Failed to create payment' })

    }

  } finally {

    if (connection) connection.release()

  }

})



// POST /api/klyme/webhook - Receive Klyme payment status updates

app.post('/api/klyme/webhook', async (req, res) => {

  let connection

  try {

    const decrypted = decryptKlymeWebhookIfNeeded(req.body)

    const payload = decrypted || req.body || {}

    const uuid = payload?.uuid || payload?.paymentUuid || payload?.payment_uuid || payload?.result?.uuid



    const derived = deriveKlymeStatus(payload)

    const status = derived.status

    const status_code = derived.statusCode



    // Log webhook for debugging

    await pool.execute(

      'INSERT INTO webhook_logs (provider, event_type, payload, received_at) VALUES (?, ?, ?, NOW())',

      ['Klyme', 'payment_status', JSON.stringify({ encrypted: req.body, decrypted: decrypted || null })]

    )



    if (!uuid) {

      // IMPORTANT: Klyme requires HTTP 200 to mark webhook delivery successful.
      // We still log/store the webhook payload above, but we ACK delivery here.
      return res.status(200).json({ ok: true, ignored: true, reason: 'Missing payment UUID' })

    }



    connection = await pool.getConnection()



    // Get payment session

    const [sessionRows] = await connection.execute(

      'SELECT * FROM payment_sessions WHERE session_id = ? LIMIT 1',

      [uuid]

    )



    if (!Array.isArray(sessionRows) || sessionRows.length === 0) {

      console.error('Klyme webhook: Payment session not found for UUID:', uuid)

      // IMPORTANT: Klyme requires HTTP 200 to mark webhook delivery successful.
      // If we return non-200, they will retry up to 5 times and then stop.
      // We ack the webhook even if we can't reconcile it yet.
      return res.status(200).json({ ok: true, ignored: true, reason: 'Payment session not found' })

    }



    const session = sessionRows[0]



    // Determine payment status

    let paymentStatus = 'pending'

    let sessionStatus = 'pending'

    let orderStatus = 'pending'

    let orderPaymentStatus = 'pending'



    if (status === 1 || status === '1') {

      // Success

      paymentStatus = 'success'

      sessionStatus = 'success'

      orderStatus = 'processing'

      orderPaymentStatus = 'received'

    } else if (status === 0 || status === '0') {

      // Failed

      paymentStatus = 'failed'

      sessionStatus = 'failed'

      orderStatus = 'pending'

      orderPaymentStatus = 'rejected'

    } else if (status === 2 || status === '2') {

      // Pending

      paymentStatus = 'pending'

      sessionStatus = 'pending'

      orderStatus = 'pending'

      orderPaymentStatus = 'pending'

    } else {

      // Unknown status - keep pending

      paymentStatus = 'pending'

      sessionStatus = 'pending'

      orderStatus = 'pending'

      orderPaymentStatus = 'pending'

    }

    if (sessionStatus === 'pending') {
      scheduleKlymeStatusRecheck(uuid)
    }



    // Read previous session status (idempotency + transitions)

    const prevSessionStatus = String(session?.status || '').trim().toLowerCase()



    // Update payment session

    await connection.execute(

      'UPDATE payment_sessions SET status = ?, updated_at = NOW() WHERE session_id = ?',

      [sessionStatus, uuid]

    )



    // Update payment record

    await connection.execute(

      `UPDATE payments 

       SET status = ?, webhook_received = TRUE, final_status = ?, status_checked_at = NOW(),

           raw_response = ?, updated_at = NOW()

       WHERE provider = 'Klyme' AND provider_id = ?`,

      [paymentStatus, status_code || paymentStatus, JSON.stringify(payload), uuid]

    )



    // Update order

    if (session.order_id) {

      await connection.execute(

        'UPDATE orders SET status = ?, payment_status = ?, updated_at = NOW() WHERE id = ?',

        [orderStatus, orderPaymentStatus, session.order_id]

      )

    }

    // Deduct credits only once the Klyme payment is confirmed successful.
    if (sessionStatus === 'success' && session?.order_id) {
      try {
        await connection.beginTransaction()
        const [oRows] = await connection.execute('SELECT order_number FROM orders WHERE id = ? LIMIT 1', [session.order_id])
        const o = Array.isArray(oRows) && oRows[0] ? oRows[0] : null
        const orderNum = String(o?.order_number || '').trim()
        if (orderNum) {
          await finalizeReservedCreditsForOrder(connection, orderNum, { source: 'order_apply_klyme_success' })
          await grantAffiliateRewardForOrder(connection, orderNum, { rewardAmount: 40 })
        }
        await connection.commit()
      } catch {
        try {
          await connection.rollback()
        } catch {
          // ignore
        }
        // ignore
      }
    }



    // Klyme payment emails (only once, only on transitions)

    try {

      const transitionedToSuccess = prevSessionStatus !== 'success' && sessionStatus === 'success'

      const transitionedToFailed = prevSessionStatus !== 'failed' && sessionStatus === 'failed'



      const [freshRows] = await connection.execute('SELECT * FROM payment_sessions WHERE session_id = ? LIMIT 1', [uuid])

      const freshSession = Array.isArray(freshRows) && freshRows[0] ? freshRows[0] : session



      if (freshSession?.order_id) {

        const [orderRows] = await connection.execute('SELECT * FROM orders WHERE id = ? LIMIT 1', [freshSession.order_id])

        const order = Array.isArray(orderRows) && orderRows[0] ? orderRows[0] : null



        const customerEmail = String(freshSession?.customer_email || order?.customer_email || '').trim()

        const customerName = String(freshSession?.customer_name || order?.customer_name || '').trim() || 'Customer'

        const orderNumber = String(order?.order_number || '').trim()



        const publicBase = (PUBLIC_API_BASE_URL || 'https://www.alluvi.store').replace(/\/$/, '')

        const trackUrl = `${publicBase}/track-order`



        if (customerEmail && customerEmail.includes('@') && orderNumber) {

          if (transitionedToSuccess) {

            console.log('[klyme/webhook] email flow: success transition', { uuid, orderNumber })

            // Payment success email

            const [sRows] = await connection.execute('SELECT success_email_sent_at, delivery_email_sent_at FROM payment_sessions WHERE session_id = ? LIMIT 1', [uuid])

            const sRow = Array.isArray(sRows) && sRows[0] ? sRows[0] : {}



            if (!sRow?.success_email_sent_at) {

              try {

                await sendKlymePaymentSuccessfulEmail(customerEmail, {

                  customerName,

                  orderNumber,

                  amount: Number(order?.total || 0),

                  currency: String(order?.currency || 'GBP'),

                  trackUrl,

                })

                await connection.execute('UPDATE payment_sessions SET success_email_sent_at = NOW() WHERE session_id = ? LIMIT 1', [uuid])

              } catch (e) {

                console.error('[klyme/webhook] payment_successful email failed', e?.message || e)

              }

            } else {

              console.log('[klyme/webhook] payment_successful email skipped (already sent)', {

                uuid,

                orderNumber,

                success_email_sent_at: sRow?.success_email_sent_at,

              })

            }



            // Delivery info email

            if (!sRow?.delivery_email_sent_at) {

              try {

                const paidAt = new Date()

                const estimate = computeUkDeliveryEstimate(paidAt)

                await sendDeliveryInformationEmail(customerEmail, {

                  customerName,

                  orderNumber,

                  deliveryText: estimate.deliveryText,

                  deliveryDateLabel: estimate.deliveryDateLabel,

                  trackUrl,

                })

                await connection.execute('UPDATE payment_sessions SET delivery_email_sent_at = NOW() WHERE session_id = ? LIMIT 1', [uuid])

              } catch (e) {

                console.error('[klyme/webhook] delivery_information email failed', e?.message || e)

              }

            } else {

              console.log('[klyme/webhook] delivery_information email skipped (already sent)', {

                uuid,

                orderNumber,

                delivery_email_sent_at: sRow?.delivery_email_sent_at,

              })

            }

          }



          if (transitionedToFailed) {

            console.log('[klyme/webhook] email flow: failed transition', { uuid, orderNumber })

            const [rRows] = await connection.execute('SELECT rejected_email_sent_at FROM payment_sessions WHERE session_id = ? LIMIT 1', [uuid])

            const rRow = Array.isArray(rRows) && rRows[0] ? rRows[0] : {}

            if (!rRow?.rejected_email_sent_at) {

              try {

                await sendKlymePaymentRejectedEmail(customerEmail, {

                  customerName,

                  orderNumber,

                  reason: String(derived?.description || derived?.statusCode || 'Payment rejected').trim(),

                  trackUrl,

                })

                await connection.execute('UPDATE payment_sessions SET rejected_email_sent_at = NOW() WHERE session_id = ? LIMIT 1', [uuid])

              } catch (e) {

                console.error('[klyme/webhook] klyme_payment_rejected email failed', e?.message || e)

              }

            } else {

              console.log('[klyme/webhook] klyme_payment_rejected email skipped (already sent)', {

                uuid,

                orderNumber,

                rejected_email_sent_at: rRow?.rejected_email_sent_at,

              })

            }

          }

        }

      }

    } catch (e) {

      console.error('[klyme/webhook] email flow error', e?.message || e)

    }



    return res.status(200).json({ ok: true, status: paymentStatus })



  } catch (err) {

    console.error('Klyme webhook error:', err)

    // IMPORTANT: Always ACK webhook delivery to prevent Klyme from exhausting retries
    // and stopping future notifications for this event.
    return res.status(200).json({ ok: true, ignored: true, reason: 'Webhook processing failed' })

  } finally {

    if (connection) connection.release()

  }

})



// GET /api/klyme/verify-payment/:uuid - Verify payment status with Klyme

app.get('/api/klyme/verify-payment/:uuid', async (req, res) => {

  let connection

  try {

    const { uuid } = req.params



    if (!uuid) {

      return res.status(400).json({ ok: false, error: 'Missing payment UUID' })

    }



    connection = await pool.getConnection()



    // Get payment session

    const [sessionRows] = await connection.execute(

      'SELECT * FROM payment_sessions WHERE session_id = ? LIMIT 1',

      [uuid]

    )



    if (!Array.isArray(sessionRows) || sessionRows.length === 0) {

      // Fallback: query Klyme and try to reconstruct session so frontend doesn't show a hard error.
      try {
        const klymeRes = await getKlymePaymentStatus(uuid)
        const derived = deriveKlymeStatus(klymeRes?.data || {})
        const statusNum = derived.status

        const raw = klymeRes?.data || {}
        const ref = String(
          raw?.reference || raw?.custom1 || raw?.result?.reference || raw?.result?.custom1 || ''
        ).trim()

        let orderId = null
        if (ref) {
          const [oRows] = await connection.execute(
            'SELECT id, order_number, customer_email, customer_name FROM orders WHERE order_number LIKE ? OR REPLACE(order_number, "ALU-", "") LIKE ? ORDER BY id DESC LIMIT 1',
            [`%${ref}%`, `%${ref}%`]
          )
          const o = Array.isArray(oRows) && oRows[0] ? oRows[0] : null
          orderId = o?.id || null

          if (orderId) {
            const frontendUrl = env('FRONTEND_URL', 'https://alluvi.store')
            const redirectUrl = `${frontendUrl}/checkout/klyme-callback`
            await connection.execute(
              `INSERT INTO payment_sessions (
                session_id, order_id, payment_provider_id, customer_email, customer_name,
                order_data, payment_url, success_url, failure_url, status, created_at, expires_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW(), DATE_ADD(NOW(), INTERVAL 1 HOUR))
              ON DUPLICATE KEY UPDATE updated_at = NOW()`,
              [
                uuid,
                orderId,
                uuid,
                o?.customer_email || null,
                o?.customer_name || null,
                JSON.stringify({ reference: ref }),
                redirectUrl,
                redirectUrl,
                redirectUrl,
              ]
            )
          }
        }

        if (statusNum === 1 || statusNum === 0 || statusNum === 2) {
          const sessionStatus = statusNum === 1 ? 'success' : statusNum === 0 ? 'failed' : 'pending'
          const paymentStatus = sessionStatus
          const orderStatus = statusNum === 1 ? 'processing' : 'pending'
          const orderPaymentStatus = statusNum === 1 ? 'received' : statusNum === 0 ? 'rejected' : 'pending'

          if (orderId) {
            await connection.execute(
              'UPDATE orders SET status = ?, payment_status = ?, updated_at = NOW() WHERE id = ?',
              [orderStatus, orderPaymentStatus, orderId]
            )
            if (String(orderPaymentStatus || '').toLowerCase() === 'received') {
              try { await grantAffiliateRewardForOrderId(connection, orderId, { rewardAmount: 40 }) } catch (e) { console.error('[klyme/verify-batch] affiliate reward failed', e?.message || e) }
            }
          }

          return res.json({
            ok: true,
            session: { uuid, status: sessionStatus, orderId },
            payment: { status: paymentStatus, finalStatus: derived.statusCode || paymentStatus, amount: null, currency: 'GBP' },
            klyme: klymeRes?.ok ? klymeRes.data : null,
          })
        }
      } catch (e) {
        console.error('[klyme/verify-payment] fallback session reconstruction failed', e?.message || e)
      }

      return res.status(404).json({ ok: false, error: 'Payment session not found' })

    }



    const session = sessionRows[0]

    const prevSessionStatus = String(session?.status || '').trim().toLowerCase()



    // Get payment record

    const [paymentRows] = await connection.execute(

      'SELECT * FROM payments WHERE provider = ? AND provider_id = ? LIMIT 1',

      ['Klyme', uuid]

    )



    const payment = paymentRows && paymentRows[0] ? paymentRows[0] : null



    // Query Klyme directly as source of truth

    let klyme = null

    let sessionStatusForResponse = String(session?.status || '').trim()

    let paymentStatusForResponse = String(payment?.status || '').trim()

    try {

      const klymeRes = await getKlymePaymentStatus(uuid)

      if (klymeRes?.ok) klyme = klymeRes.data



      const derived = deriveKlymeStatus(klymeRes?.data || {})

      const statusNum = derived.status

      if (!(statusNum === 1 || statusNum === 0 || statusNum === 2)) {
        try {
          const d = klymeRes?.data || {}
          const r = d?.result || {}
          console.log('[klyme/verify-payment] unable to derive status', {
            uuid,
            topStatus: d?.status,
            topStatusCode: d?.status_code || d?.statusCode,
            resultStatus: r?.status,
            resultStatusCode: r?.status_code || r?.statusCode,
            description: d?.description || r?.description,
          })
        } catch {
          // ignore
        }
      }



      if (statusNum === 1 || statusNum === 0 || statusNum === 2) {

        const sessionStatus = statusNum === 1 ? 'success' : statusNum === 0 ? 'failed' : 'pending'

        const paymentStatus = statusNum === 1 ? 'success' : statusNum === 0 ? 'failed' : 'pending'

        const orderStatus = statusNum === 1 ? 'processing' : 'pending'

        const orderPaymentStatus = statusNum === 1 ? 'received' : statusNum === 0 ? 'rejected' : 'pending'



        await connection.execute(

          'UPDATE payment_sessions SET status = ?, updated_at = NOW() WHERE session_id = ?',

          [sessionStatus, uuid]

        )



        await connection.execute(

          `UPDATE payments

           SET status = ?, final_status = ?, status_checked_at = NOW(), raw_response = ?, updated_at = NOW()

           WHERE provider = 'Klyme' AND provider_id = ?`,

          [paymentStatus, derived.statusCode || paymentStatus, JSON.stringify(klymeRes?.data || {}), uuid]

        )



        if (session.order_id) {

          await connection.execute(

            'UPDATE orders SET status = ?, payment_status = ?, updated_at = NOW() WHERE id = ?',

            [orderStatus, orderPaymentStatus, session.order_id]

          )

          if (String(orderPaymentStatus || '').toLowerCase() === 'received') {
            try { await grantAffiliateRewardForOrderId(connection, session.order_id, { rewardAmount: 40 }) } catch (e) { console.error('[klyme/verify-other] affiliate reward failed', e?.message || e) }
          }

        }

        sessionStatusForResponse = sessionStatus

        paymentStatusForResponse = paymentStatus

        // Klyme payment emails (idempotent). We send on transitions, but also
        // send if verify-payment confirms a final status and the email wasn't sent yet.
        try {
          const transitionedToSuccess = prevSessionStatus !== 'success' && sessionStatus === 'success'
          const transitionedToFailed = prevSessionStatus !== 'failed' && sessionStatus === 'failed'

          const [freshRows] = await connection.execute('SELECT * FROM payment_sessions WHERE session_id = ? LIMIT 1', [uuid])
          const freshSession = Array.isArray(freshRows) && freshRows[0] ? freshRows[0] : session

          if (freshSession?.order_id) {
            const [orderRows] = await connection.execute('SELECT * FROM orders WHERE id = ? LIMIT 1', [freshSession.order_id])
            const order = Array.isArray(orderRows) && orderRows[0] ? orderRows[0] : null

            const customerEmail = String(freshSession?.customer_email || order?.customer_email || '').trim()
            const customerName = String(freshSession?.customer_name || order?.customer_name || '').trim() || 'Customer'
            const orderNumber = String(order?.order_number || '').trim()

            const publicBase = (PUBLIC_API_BASE_URL || 'https://www.alluvi.store').replace(/\/$/, '')
            const trackUrl = `${publicBase}/track-order`

            if (sessionStatus === 'success' && orderNumber) {
              try {
                await finalizeReservedCreditsForOrder(connection, orderNumber, { source: 'order_apply_klyme_success_verify' })
              } catch {
                // ignore
              }
            }

            if (customerEmail && customerEmail.includes('@') && orderNumber) {
              const [sRows] = await connection.execute(
                'SELECT success_email_sent_at, delivery_email_sent_at, rejected_email_sent_at FROM payment_sessions WHERE session_id = ? LIMIT 1',
                [uuid]
              )
              const sRow = Array.isArray(sRows) && sRows[0] ? sRows[0] : {}

              const shouldSendSuccess = sessionStatus === 'success' && !sRow?.success_email_sent_at
              const shouldSendDelivery = sessionStatus === 'success' && !sRow?.delivery_email_sent_at
              const shouldSendRejected = sessionStatus === 'failed' && !sRow?.rejected_email_sent_at

              if (transitionedToSuccess) {
                console.log('[klyme/verify-payment] email flow: success transition', { uuid, orderNumber })
              }
              if (transitionedToFailed) {
                console.log('[klyme/verify-payment] email flow: failed transition', { uuid, orderNumber })
              }

              if (shouldSendSuccess) {
                try {
                  await sendKlymePaymentSuccessfulEmail(customerEmail, {
                    customerName,
                    orderNumber,
                    amount: Number(order?.total || 0),
                    currency: String(order?.currency || 'GBP'),
                    trackUrl,
                  })
                  await connection.execute('UPDATE payment_sessions SET success_email_sent_at = NOW() WHERE session_id = ? LIMIT 1', [uuid])
                } catch (e) {
                  console.error('[klyme/verify-payment] payment_successful email failed', e?.message || e)
                }
              } else if (sessionStatus === 'success') {
                console.log('[klyme/verify-payment] payment_successful email skipped (already sent)', {
                  uuid,
                  orderNumber,
                  success_email_sent_at: sRow?.success_email_sent_at,
                })
              }

              if (shouldSendDelivery) {
                try {
                  const paidAt = new Date()
                  const estimate = computeUkDeliveryEstimate(paidAt)
                  await sendDeliveryInformationEmail(customerEmail, {
                    customerName,
                    orderNumber,
                    deliveryText: estimate.deliveryText,
                    deliveryDateLabel: estimate.deliveryDateLabel,
                    trackUrl,
                  })
                  await connection.execute('UPDATE payment_sessions SET delivery_email_sent_at = NOW() WHERE session_id = ? LIMIT 1', [uuid])
                } catch (e) {
                  console.error('[klyme/verify-payment] delivery_information email failed', e?.message || e)
                }
              } else if (sessionStatus === 'success') {
                console.log('[klyme/verify-payment] delivery_information email skipped (already sent)', {
                  uuid,
                  orderNumber,
                  delivery_email_sent_at: sRow?.delivery_email_sent_at,
                })
              }

              if (shouldSendRejected) {
                try {
                  await sendKlymePaymentRejectedEmail(customerEmail, {
                    customerName,
                    orderNumber,
                    reason: String(derived?.description || derived?.statusCode || 'Payment rejected').trim(),
                    trackUrl,
                  })
                  await connection.execute('UPDATE payment_sessions SET rejected_email_sent_at = NOW() WHERE session_id = ? LIMIT 1', [uuid])
                } catch (e) {
                  console.error('[klyme/verify-payment] klyme_payment_rejected email failed', e?.message || e)
                }
              } else if (sessionStatus === 'failed') {
                console.log('[klyme/verify-payment] klyme_payment_rejected email skipped (already sent)', {
                  uuid,
                  orderNumber,
                  rejected_email_sent_at: sRow?.rejected_email_sent_at,
                })
              }
            } else {
              console.log('[klyme/verify-payment] email flow skipped (missing customerEmail/orderNumber)', {
                uuid,
                hasCustomerEmail: !!customerEmail,
                hasOrderNumber: !!orderNumber,
              })
            }
          }
        } catch (e) {
          console.error('[klyme/verify-payment] email flow error', e?.message || e)
        }

      }

    } catch (e) {

      // ignore upstream errors

    }



    return res.json({

      ok: true,

      session: {

        uuid: session.session_id,

        status: sessionStatusForResponse,

        orderId: session.order_id,

      },

      payment: payment ? {

        status: paymentStatusForResponse,

        finalStatus: payment.final_status,

        amount: payment.amount,

        currency: payment.currency,

      } : null,

      klyme,

    })



  } catch (err) {

    console.error('Verify Klyme payment error:', err)

    return res.status(500).json({ ok: false, error: err?.message || 'Verification failed' })

  } finally {

    if (connection) connection.release()

  }

})



// =====================================================

// AABANPAY PAYMENT GATEWAY INTEGRATION

// =====================================================



const AABANPAY_API_BASE = process.env.AABANPAY_API_URL || 'https://aabanpay.com/rest/api';
const AABANPAY_API_KEY = process.env.AABANPAY_API_KEY || '';

function aabanpayAuthToken() {
  // Plugin uses base64(api_key) passed as a body/query field named Authorization.
  return Buffer.from(String(AABANPAY_API_KEY || ''), 'utf8').toString('base64')
}

function aabanpayCardTypeNumber(raw) {
  const t = String(raw || '').trim().toLowerCase()
  if (t === 'visa') return 2
  if (t === 'mastercard' || t === 'master card') return 3
  if (t === 'discover') return 4
  if (t === 'amex' || t === 'american express') return 1
  return null
}

function aabanpayNormalizeCountry(raw) {
  const v = String(raw || '').trim()
  if (!v) return ''
  const up = v.toUpperCase()
  if (up === 'GB' || up === 'UK') return 'GB'
  if (up === 'UNITED KINGDOM' || up === 'GREAT BRITAIN' || up === 'ENGLAND') return 'GB'
  // If already looks like ISO2, keep it.
  if (/^[A-Z]{2}$/.test(up)) return up
  return v
}

async function fetchAabanPayTransactionsByExtId(extOrderId) {
  const auth = aabanpayAuthToken()
  const base = String(AABANPAY_API_BASE || '').trim().replace(/\/$/, '')
  const url = `${base}/find-by-ext-id/${encodeURIComponent(String(extOrderId))}?Authorization=${encodeURIComponent(auth)}`

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  })

  const text = await response.text().catch(() => '')
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }

  return { ok: response.ok, status: response.status, data, rawText: text }
}

/**
 * Check if product should use AabanPay (only product ID 32)
 */
function isAabanPayProduct(productId) {
  const id = String(productId);
  return id === '32' ||
    id === 'test-product' ||
    id === 'retatrutide-20mg' ||
    id === 'retatrutide-40mg';
}

/**
 * Check if order contains only AabanPay-eligible products
 */
async function isAabanPayOrder(connection, orderId) {
  try {
    const [items] = await connection.execute(
      'SELECT product_id, sku FROM order_items WHERE order_id = ?',
      [orderId]
    );
    if (!Array.isArray(items) || items.length === 0) return false;
    return items.every(item => {
      // Check product_id first (for numeric IDs), fallback to sku (for string IDs like retatrutide-20mg)
      const pid = item.product_id;
      if (pid !== null && pid !== undefined) return isAabanPayProduct(pid);
      return isAabanPayProduct(item.sku);
    });
  } catch (e) {
    console.error('[AabanPay] isAabanPayOrder check failed:', e?.message || e);
    return false;
  }
}

// POST /api/aabanpay/create-payment - Create AabanPay payment session
const aabanpayCreatePaymentHandler = async (req, res) => {
  let connection;
  try {
    const { orderId, amount, currency = 'GBP', returnUrl, cancelUrl } = req.body;

    if (!AABANPAY_API_KEY) {
      return res.status(500).json({ ok: false, error: 'AabanPay API key not configured' });
    }

    if (!orderId || !amount) {
      return res.status(400).json({ ok: false, error: 'Missing required fields: orderId, amount' });
    }

    connection = await pool.getConnection();

    // Get order from database
    const [orderRows] = await connection.execute(
      'SELECT * FROM orders WHERE order_number = ? LIMIT 1',
      [orderId]
    );

    if (!Array.isArray(orderRows) || orderRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Order not found' });
    }

    const order = orderRows[0];

    // Verify this order is eligible for AabanPay
    const isEligible = await isAabanPayOrder(connection, order.id);
    if (!isEligible) {
      return res.status(400).json({ ok: false, error: 'Order not eligible for AabanPay' });
    }

    // Create redirect URLs
    const frontendUrl = env('FRONTEND_URL', 'https://alluvi.store');
    const successUrl = returnUrl || `${frontendUrl}/checkout/aabanpay-callback?status=success`;
    const failureUrl = cancelUrl || `${frontendUrl}/checkout/aabanpay-callback?status=cancelled`;
    const webhookUrl = `${env('PUBLIC_API_BASE_URL', frontendUrl)}/api/aabanpay/webhook`;

    // Call AabanPay API to create payment
    const payload = {
      api_key: AABANPAY_API_KEY,
      amount: Number(amount).toFixed(2),
      currency: currency.toUpperCase(),
      order_id: String(orderId),
      customer_email: String(order.customer_email || '').trim(),
      customer_name: String(order.customer_name || '').trim(),
      description: `Order ${orderId}`,
      return_url: successUrl,
      cancel_url: failureUrl,
      webhook_url: webhookUrl,
      metadata: {
        internal_order_id: order.id,
        source: 'alluvi_store',
      },
    };

    const response = await fetch(`${AABANPAY_API_BASE}/payment/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AABANPAY_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AabanPay] API error:', errorText);
      return res.status(response.status).json({
        ok: false,
        error: `AabanPay API error: ${response.status}`,
      });
    }

    const data = await response.json();
    const sessionId = data.session_id || data.id || data.transaction_id;
    const paymentUrl = data.payment_url || data.url;

    if (!sessionId || !paymentUrl) {
      return res.status(500).json({ ok: false, error: 'AabanPay did not return session details' });
    }

    // Store payment session in database
    await connection.execute(
      `INSERT INTO payment_sessions (
        session_id, order_id, payment_provider_id, customer_email, customer_name,
        order_data, payment_url, success_url, failure_url, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW(), DATE_ADD(NOW(), INTERVAL 1 HOUR))
      ON DUPLICATE KEY UPDATE
        payment_provider_id = VALUES(payment_provider_id),
        status = 'pending',
        updated_at = NOW()`,
      [
        sessionId,
        order.id,
        sessionId,
        order.customer_email,
        order.customer_name,
        JSON.stringify({ orderId: order.order_number, amount: Number(amount).toFixed(2), currency }),
        paymentUrl,
        successUrl,
        failureUrl,
      ]
    );

    // Store in payments table
    await connection.execute(
      `INSERT INTO payments (order_id, provider, provider_id, amount, currency, status, raw_response, created_at)
       VALUES (?, 'AabanPay', ?, ?, ?, 'pending', ?, NOW())
       ON DUPLICATE KEY UPDATE
         amount = VALUES(amount),
         currency = VALUES(currency),
         status = 'pending',
         updated_at = NOW()`,
      [order.id, sessionId, Number(amount).toFixed(2), currency || 'GBP', JSON.stringify(data)]
    );

    return res.json({
      ok: true,
      sessionId: sessionId,
      paymentUrl: paymentUrl,
      orderId: order.order_number,
    });

  } catch (err) {
    console.error('[AabanPay] Create payment error:', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Failed to create payment' });
  } finally {
    if (connection) connection.release();
  }
};

app.post('/api/aabanpay/create-payment', aabanpayCreatePaymentHandler);
// Alias under /api/user-orders/* to match existing working routing/CORS setup.
app.post('/api/user-orders/aabanpay/create-payment', aabanpayCreatePaymentHandler);

// POST /api/aabanpay/webhook - Receive AabanPay payment status updates
const aabanpayWebhookHandler = async (req, res) => {
  let connection;
  try {
    const payload = req.body || {};
    const sessionId = payload.session_id || payload.id || payload.transaction_id;
    const status = payload.status;

    // Log webhook for debugging
    await pool.execute(
      'INSERT INTO webhook_logs (provider, event_type, payload, received_at) VALUES (?, ?, ?, NOW())',
      ['AabanPay', 'payment_status', JSON.stringify(payload)]
    );

    if (!sessionId) {
      return res.status(200).json({ ok: true, ignored: true, reason: 'Missing session ID' });
    }

    connection = await pool.getConnection();

    // Get payment session
    const [sessionRows] = await connection.execute(
      'SELECT * FROM payment_sessions WHERE session_id = ? LIMIT 1',
      [sessionId]
    );

    if (!Array.isArray(sessionRows) || sessionRows.length === 0) {
      console.error('[AabanPay] Webhook: Payment session not found for ID:', sessionId);
      return res.status(200).json({ ok: true, ignored: true, reason: 'Payment session not found' });
    }

    const session = sessionRows[0];
    const prevSessionStatus = String(session?.status || '').trim().toLowerCase();

    // Determine payment status
    const normalizedStatus = String(status || '').toLowerCase();
    let paymentStatus = 'pending';
    let sessionStatus = 'pending';
    let orderStatus = 'pending';
    let orderPaymentStatus = 'pending';

    if (normalizedStatus === 'completed' || normalizedStatus === 'success') {
      paymentStatus = 'success';
      sessionStatus = 'success';
      orderStatus = 'processing';
      orderPaymentStatus = 'received';
    } else if (normalizedStatus === 'failed' || normalizedStatus === 'rejected' || normalizedStatus === 'cancelled') {
      paymentStatus = 'failed';
      sessionStatus = 'failed';
      orderStatus = 'pending';
      orderPaymentStatus = 'rejected';
    }

    // Update payment session
    await connection.execute(
      'UPDATE payment_sessions SET status = ?, updated_at = NOW() WHERE session_id = ?',
      [sessionStatus, sessionId]
    );

    // Update payment record
    await connection.execute(
      `UPDATE payments 
       SET status = ?, webhook_received = TRUE, final_status = ?, status_checked_at = NOW(),
           raw_response = ?, updated_at = NOW()
       WHERE provider = 'AabanPay' AND provider_id = ?`,
      [paymentStatus, normalizedStatus, JSON.stringify(payload), sessionId]
    );

    // Update order
    if (session.order_id) {
      await connection.execute(
        'UPDATE orders SET status = ?, payment_status = ?, updated_at = NOW() WHERE id = ?',
        [orderStatus, orderPaymentStatus, session.order_id]
      );
      if (String(orderPaymentStatus || '').toLowerCase() === 'received') {
        try { await grantAffiliateRewardForOrderId(connection, session.order_id, { rewardAmount: 40 }); } catch (e) { console.error('[aabanpay/webhook] affiliate reward failed', e?.message || e); }
      }
    }

    return res.status(200).json({ ok: true, status: paymentStatus });

  } catch (err) {
    console.error('[AabanPay] Webhook error:', err);
    return res.status(200).json({ ok: true, ignored: true, reason: 'Webhook processing failed' });
  } finally {
    if (connection) connection.release();
  }
};

app.post('/api/aabanpay/webhook', aabanpayWebhookHandler);
// Alias under /api/user-orders/* to match existing working routing/CORS setup.
app.post('/api/user-orders/aabanpay/webhook', aabanpayWebhookHandler);

// GET /api/aabanpay/verify-payment/:sessionId - Verify payment status with AabanPay
const aabanpayVerifyPaymentHandler = async (req, res) => {
  let connection;
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({ ok: false, error: 'Missing session ID' });
    }

    if (!AABANPAY_API_KEY) {
      return res.status(500).json({ ok: false, error: 'AabanPay API key not configured' });
    }

    connection = await pool.getConnection();

    // Get payment session
    const [sessionRows] = await connection.execute(
      'SELECT * FROM payment_sessions WHERE session_id = ? LIMIT 1',
      [sessionId]
    );

    if (!Array.isArray(sessionRows) || sessionRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Payment session not found' });
    }

    const session = sessionRows[0];

    // Query AabanPay for current status
    const response = await fetch(`${AABANPAY_API_BASE}/payment/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AABANPAY_API_KEY}`,
      },
      body: JSON.stringify({
        api_key: AABANPAY_API_KEY,
        session_id: sessionId,
      }),
    });

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: `AabanPay API error: ${response.status}`,
      });
    }

    const data = await response.json();
    const normalizedStatus = String(data.status || '').toLowerCase();

    let paymentStatus = 'pending';
    let sessionStatus = 'pending';
    let orderStatus = 'pending';
    let orderPaymentStatus = 'pending';

    if (normalizedStatus === 'completed' || normalizedStatus === 'success') {
      paymentStatus = 'success';
      sessionStatus = 'success';
      orderStatus = 'processing';
      orderPaymentStatus = 'received';
    } else if (normalizedStatus === 'failed' || normalizedStatus === 'rejected' || normalizedStatus === 'cancelled') {
      paymentStatus = 'failed';
      sessionStatus = 'failed';
      orderStatus = 'pending';
      orderPaymentStatus = 'rejected';
    }

    // Update local records
    await connection.execute(
      'UPDATE payment_sessions SET status = ?, updated_at = NOW() WHERE session_id = ?',
      [sessionStatus, sessionId]
    );

    await connection.execute(
      `UPDATE payments 
       SET status = ?, final_status = ?, status_checked_at = NOW(), raw_response = ?, updated_at = NOW()
       WHERE provider = 'AabanPay' AND provider_id = ?`,
      [paymentStatus, normalizedStatus, JSON.stringify(data), sessionId]
    );

    if (session.order_id) {
      await connection.execute(
        'UPDATE orders SET status = ?, payment_status = ?, updated_at = NOW() WHERE id = ?',
        [orderStatus, orderPaymentStatus, session.order_id]
      );
      if (String(orderPaymentStatus || '').toLowerCase() === 'received') {
        try { await grantAffiliateRewardForOrderId(connection, session.order_id, { rewardAmount: 40 }); } catch (e) { console.error('[aabanpay/verify] affiliate reward failed', e?.message || e); }
      }
    }

    return res.json({
      ok: true,
      session: {
        sessionId: session.session_id,
        status: sessionStatus,
        orderId: session.order_id,
      },
      payment: {
        status: paymentStatus,
        finalStatus: normalizedStatus,
      },
      aabanpay: data,
    });

  } catch (err) {
    console.error('[AabanPay] Verify payment error:', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Verification failed' });
  } finally {
    if (connection) connection.release();
  }
};

app.get('/api/aabanpay/verify-payment/:sessionId', aabanpayVerifyPaymentHandler);
// Alias under /api/user-orders/* to match existing working routing/CORS setup.
app.get('/api/user-orders/aabanpay/verify-payment/:sessionId', aabanpayVerifyPaymentHandler);



// POST /api/user-orders/aabanpay/charge - Direct card charge (plugin-compatible)
// NOTE: This is intended for test product (ID 32) only.
app.post('/api/user-orders/aabanpay/charge', async (req, res) => {
  let connection
  try {
    if (!AABANPAY_API_KEY) return res.status(500).json({ ok: false, error: 'AabanPay API key not configured' })

    const {
      orderId,
      cardNumber,
      cardType,
      expMonth,
      expYear,
      cvv,
    } = req.body || {}

    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId is required' })
    if (!cardNumber || !expMonth || !expYear || !cvv) return res.status(400).json({ ok: false, error: 'Missing card fields' })

    const typeNum = aabanpayCardTypeNumber(cardType)
    if (!typeNum) return res.status(400).json({ ok: false, error: 'Invalid cardType (use visa/mastercard/amex/discover)' })

    connection = await pool.getConnection()

    const [orderRows] = await connection.execute('SELECT * FROM orders WHERE order_number = ? LIMIT 1', [String(orderId).trim()])
    const order = Array.isArray(orderRows) && orderRows[0] ? orderRows[0] : null
    if (!order?.id) return res.status(404).json({ ok: false, error: 'Order not found' })

    const eligible = await isAabanPayOrder(connection, order.id)
    if (!eligible) return res.status(400).json({ ok: false, error: 'Order not eligible for AabanPay' })

    // Build plugin-style payload
    const auth = aabanpayAuthToken()
    const year4 = String(expYear).length === 2 ? `20${String(expYear)}` : String(expYear)

    const phoneRaw = String(order.customer_phone || '').trim() || ''
    const phone = phoneRaw ? phoneRaw.replace(/[^0-9+]/g, '') : ''

    const shippingCountryRaw = String(order.shipping_country || '').trim()
    const shippingCountry = aabanpayNormalizeCountry(shippingCountryRaw)
    const shippingCity = String(order.shipping_city || '').trim()
    const shippingZip = String(order.shipping_zip || '').trim().replace(/\s+/g, '')
    const shippingStateRaw = String(order.shipping_state || '').trim()
    const shippingState = shippingStateRaw || shippingCity || (shippingCountry ? shippingCountry : 'UK')

    const callbackBase = String(env('PUBLIC_API_BASE_URL', env('FRONTEND_URL', 'https://alluvi.store')) || '').replace(/\/$/, '')
    const callbackurl = `${callbackBase}/api/user-orders/aabanpay/callback?order_id=${encodeURIComponent(String(order.order_number))}`

    // Use callback as returnurl so it processes payment status and redirects to correct page
    const returnurl = callbackurl

    const [itemsRows] = await connection.execute(
      'SELECT product_id, name, quantity, unit_price, line_total FROM order_items WHERE order_id = ? ORDER BY id ASC',
      [Number(order.id)]
    )
    const items = Array.isArray(itemsRows) ? itemsRows : []
    const orderDetails = items.map((it) => ({
      product_id: it?.product_id ?? null,
      name: String(it?.name || ''),
      quantity: Number(it?.quantity || 1),
      price: Number(it?.unit_price || 0),
      subtotal: Number(it?.unit_price || 0) * Number(it?.quantity || 1),
      total: Number(it?.line_total || 0),
    }))

    const payload = {
      Authorization: auth,
      userData: {
        first_name: String(order.customer_name || '').trim().split(' ')[0] || '',
        last_name: String(order.customer_name || '').trim().split(' ').slice(1).join(' ') || '',
        email: String(order.customer_email || '').trim(),
        address: String(order.shipping_address || '').trim(),
        country: shippingCountry,
        state: shippingState,
        city: shippingCity,
        zip: shippingZip,
        phone: phone,
        address1: '',
        ip: String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
      },
      cardData: {
        name: String(order.customer_name || '').trim() || 'Customer',
        type: typeNum,
        number: String(cardNumber),
        month: String(parseInt(String(expMonth), 10) || ''),
        year: String(year4),
        cvv: String(cvv),
      },
      amount: Number(order.total || 0),
      currency: String(order.currency || 'GBP'),
      ext_order_id: String(order.order_number || '').trim(),
      returnurl,
      callbackurl,
      order_details: orderDetails,
    }

    console.log('[AabanPay] Charging card with credit-adjusted total:', {
      orderId: order.order_number,
      originalTotal: Number(order.total_before_credits || 0),
      creditsApplied: Number(order.credits_applied || 0),
      chargeAmount: Number(order.total || 0)
    })

    // NEVER log card fields

    const response = await fetch(String(AABANPAY_API_BASE || '').trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
    })

    const text = await response.text().catch(() => '')
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      return res.status(502).json({ ok: false, error: `AabanPay request failed (${response.status})`, provider: data || text })
    }

    const status = String(data?.status || '').trim().toUpperCase()
    const txnId = data?.id || null
    const descriptor = data?.descriptor || null
    const threeDsUrl = data?.['3ds_url'] || data?.three_ds_url || data?.redirect3dsUrl || null
    const info = data?.information_data || null

    // Persist payment record (do not store PAN/CVV)
    try {
      await connection.execute(
        `INSERT INTO payments (order_id, provider, provider_id, amount, currency, status, raw_response, created_at)
         VALUES (?, 'AabanPay', ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE status = VALUES(status), raw_response = VALUES(raw_response), updated_at = NOW()`,
        [Number(order.id), String(txnId || `AABANPAY-${order.order_number}`), Number(order.total || 0), String(order.currency || 'GBP'), status || 'PENDING', JSON.stringify(data || {})]
      )
    } catch {
      // ignore
    }

    // Ensure we have a payment_sessions row for idempotent email timestamps (best-effort).
    const sessionKey = String(txnId || `AABANPAY-${order.order_number}`)
    try {
      await connection.execute(
        `INSERT INTO payment_sessions (
          session_id, order_id, payment_provider_id, customer_email, customer_name,
          order_data, payment_url, success_url, failure_url, status, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 HOUR))
        ON DUPLICATE KEY UPDATE
          payment_provider_id = VALUES(payment_provider_id),
          customer_email = VALUES(customer_email),
          customer_name = VALUES(customer_name),
          status = VALUES(status),
          updated_at = NOW()`,
        [
          sessionKey,
          Number(order.id),
          sessionKey,
          String(order.customer_email || '').trim(),
          String(order.customer_name || '').trim(),
          JSON.stringify({ orderId: order.order_number, amount: Number(order.total || 0).toFixed(2), currency: String(order.currency || 'GBP') }),
          String(status || 'PENDING').toLowerCase() === 'approved' ? 'success' : (String(status || '').toLowerCase().includes('declin') ? 'failed' : 'pending'),
        ]
      )
    } catch {
      // ignore
    }

    if (status === 'APPROVED') {
      try {
        await connection.execute('UPDATE orders SET status = ?, payment_status = ?, updated_at = NOW() WHERE id = ? LIMIT 1', ['processing', 'received', Number(order.id)])
        try { await grantAffiliateRewardForOrderId(connection, Number(order.id), { rewardAmount: 40 }) } catch (e) { console.error('[aabanpay/charge] affiliate reward failed', e?.message || e) }
      } catch {
        // ignore
      }

      // Klyme-style emails (send 2 on success): payment successful + delivery info
      try {
        const customerEmail = String(order.customer_email || '').trim()
        const customerName = String(order.customer_name || '').trim() || 'Customer'
        const orderNumber = String(order.order_number || '').trim()
        const publicBase = (PUBLIC_API_BASE_URL || 'https://www.alluvi.store').replace(/\/$/, '')
        const trackUrl = `${publicBase}/track-order`

        if (customerEmail && customerEmail.includes('@') && orderNumber) {
          let sRow = {}
          try {
            const [sRows] = await connection.execute(
              'SELECT success_email_sent_at, delivery_email_sent_at FROM payment_sessions WHERE session_id = ? LIMIT 1',
              [sessionKey]
            )
            sRow = Array.isArray(sRows) && sRows[0] ? sRows[0] : {}
          } catch {
            sRow = {}
          }

          if (!sRow?.success_email_sent_at) {
            try {
              await sendKlymePaymentSuccessfulEmail(customerEmail, {
                customerName,
                orderNumber,
                amount: Number(order.total || 0),
                currency: String(order.currency || 'GBP'),
                trackUrl,
              })
              try {
                await connection.execute('UPDATE payment_sessions SET success_email_sent_at = NOW() WHERE session_id = ? LIMIT 1', [sessionKey])
              } catch {
                // ignore
              }
            } catch (e) {
              console.error('[aabanpay/charge] klyme_payment_successful email failed', e?.message || e)
            }
          }

          if (!sRow?.delivery_email_sent_at) {
            try {
              const paidAt = new Date()
              const estimate = computeUkDeliveryEstimate(paidAt)
              await sendDeliveryInformationEmail(customerEmail, {
                customerName,
                orderNumber,
                deliveryText: estimate.deliveryText,
                deliveryDateLabel: estimate.deliveryDateLabel,
                trackUrl,
              })
              try {
                await connection.execute('UPDATE payment_sessions SET delivery_email_sent_at = NOW() WHERE session_id = ? LIMIT 1', [sessionKey])
              } catch {
                // ignore
              }
            } catch (e) {
              console.error('[aabanpay/charge] delivery_information email failed', e?.message || e)
            }
          }
        }
      } catch (e) {
        console.error('[aabanpay/charge] success email flow failed', e?.message || e)
      }

      return res.json({ ok: true, status: 'APPROVED', transactionId: txnId, descriptor })
    }

    if (status === 'PROCESSING - PENDING VERIFICATION' && threeDsUrl) {
      return res.json({ ok: true, status: '3DS', transactionId: txnId, descriptor, threeDsUrl })
    }

    // Treat anything else as declined/rejected.
    try {
      await connection.execute('UPDATE orders SET status = ?, payment_status = ?, updated_at = NOW() WHERE id = ? LIMIT 1', ['pending', 'rejected', Number(order.id)])
    } catch {
      // ignore
    }

    // Klyme-style rejected email
    try {
      const customerEmail = String(order.customer_email || '').trim()
      const customerName = String(order.customer_name || '').trim() || 'Customer'
      const orderNumber = String(order.order_number || '').trim()
      const publicBase = (PUBLIC_API_BASE_URL || 'https://www.alluvi.store').replace(/\/$/, '')
      const trackUrl = `${publicBase}/track-order`
      const reason = String(info || status || 'Payment rejected').trim()

      if (customerEmail && customerEmail.includes('@') && orderNumber) {
        let rRow = {}
        try {
          const [rRows] = await connection.execute(
            'SELECT rejected_email_sent_at FROM payment_sessions WHERE session_id = ? LIMIT 1',
            [sessionKey]
          )
          rRow = Array.isArray(rRows) && rRows[0] ? rRows[0] : {}
        } catch {
          rRow = {}
        }

        if (!rRow?.rejected_email_sent_at) {
          try {
            await sendKlymePaymentRejectedEmail(customerEmail, {
              customerName,
              orderNumber,
              reason,
              trackUrl,
            })
            try {
              await connection.execute('UPDATE payment_sessions SET rejected_email_sent_at = NOW() WHERE session_id = ? LIMIT 1', [sessionKey])
            } catch {
              // ignore
            }
          } catch (e) {
            console.error('[aabanpay/charge] klyme_payment_rejected email failed', e?.message || e)
          }
        }
      }
    } catch (e) {
      console.error('[aabanpay/charge] rejected email flow failed', e?.message || e)
    }

    return res.status(400).json({ ok: false, status: status || 'DECLINED', error: info || 'Payment declined', provider: data })
  } catch (e) {
    console.error('[aabanpay/charge] failed', e?.message || String(e))
    return res.status(500).json({ ok: false, error: e?.message || 'Charge failed' })
  } finally {
    if (connection) connection.release()
  }
})

// GET /api/user-orders/aabanpay/callback - Provider callback after 3DS
app.get('/api/user-orders/aabanpay/callback', async (req, res) => {
  let connection
  try {
    const extOrderId = String(req.query?.order_id || '').trim()
    if (!extOrderId) return res.status(400).send('Missing order_id')

    const lookup = await fetchAabanPayTransactionsByExtId(extOrderId)
    if (!lookup.ok) return res.status(502).send('Failed to fetch transaction')

    const list = Array.isArray(lookup.data) ? lookup.data : []
    const tx = list.find((t) => String(t?.ext_order_id || '').trim() === extOrderId) || list[0] || null
    if (!tx) return res.status(404).send('Transaction not found')

    const txStatus = String(tx?.status || '').trim().toUpperCase()
    const txId = tx?.id || null
    const info = tx?.information_data || null

    connection = await pool.getConnection()
    const [orderRows] = await connection.execute(
      'SELECT id, order_number, customer_email, customer_name, total, currency FROM orders WHERE order_number = ? LIMIT 1',
      [extOrderId]
    )
    const order = Array.isArray(orderRows) && orderRows[0] ? orderRows[0] : null
    if (!order?.id) return res.status(404).send('Order not found')

    const sessionKey = String(txId || `AABANPAY-${extOrderId}`)

    // Ensure we have a payment_sessions row for idempotent email timestamps (best-effort).
    try {
      await connection.execute(
        `INSERT INTO payment_sessions (
          session_id, order_id, payment_provider_id, customer_email, customer_name,
          order_data, payment_url, success_url, failure_url, status, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 HOUR))
        ON DUPLICATE KEY UPDATE
          payment_provider_id = VALUES(payment_provider_id),
          customer_email = VALUES(customer_email),
          customer_name = VALUES(customer_name),
          status = VALUES(status),
          updated_at = NOW()`,
        [
          sessionKey,
          Number(order.id),
          sessionKey,
          String(order.customer_email || '').trim(),
          String(order.customer_name || '').trim(),
          JSON.stringify({ orderId: String(order.order_number || extOrderId), amount: Number(order.total || 0).toFixed(2), currency: String(order.currency || 'GBP') }),
          txStatus === 'APPROVED' ? 'success' : (txStatus === 'DECLINED' ? 'failed' : 'pending'),
        ]
      )
    } catch {
      // ignore
    }

    if (txStatus === 'APPROVED') {
      await connection.execute('UPDATE orders SET status = ?, payment_status = ?, updated_at = NOW() WHERE id = ? LIMIT 1', ['processing', 'received', Number(order.id)])
      try { await grantAffiliateRewardForOrderId(connection, Number(order.id), { rewardAmount: 40 }) } catch (e) { console.error('[aabanpay/callback] affiliate reward failed', e?.message || e) }
      await connection.execute(
        `UPDATE payments SET status = ?, final_status = ?, raw_response = ?, updated_at = NOW()
         WHERE provider = 'AabanPay' AND order_id = ?`,
        ['APPROVED', 'APPROVED', JSON.stringify(tx), Number(order.id)]
      )

      // Success emails (idempotent)
      try {
        const customerEmail = String(order.customer_email || '').trim()
        const customerName = String(order.customer_name || '').trim() || 'Customer'
        const orderNumber = String(order.order_number || extOrderId).trim()
        const publicBase = (PUBLIC_API_BASE_URL || 'https://www.alluvi.store').replace(/\/$/, '')
        const trackUrl = `${publicBase}/track-order`

        if (customerEmail && customerEmail.includes('@') && orderNumber) {
          let sRow = {}
          try {
            const [sRows] = await connection.execute(
              'SELECT success_email_sent_at, delivery_email_sent_at FROM payment_sessions WHERE session_id = ? LIMIT 1',
              [sessionKey]
            )
            sRow = Array.isArray(sRows) && sRows[0] ? sRows[0] : {}
          } catch {
            sRow = {}
          }

          if (!sRow?.success_email_sent_at) {
            try {
              await sendKlymePaymentSuccessfulEmail(customerEmail, {
                customerName,
                orderNumber,
                amount: Number(order.total || 0),
                currency: String(order.currency || 'GBP'),
                trackUrl,
              })
              try {
                await connection.execute('UPDATE payment_sessions SET success_email_sent_at = NOW() WHERE session_id = ? LIMIT 1', [sessionKey])
              } catch {
                // ignore
              }
            } catch (e) {
              console.error('[aabanpay/callback] klyme_payment_successful email failed', e?.message || e)
            }
          }

          if (!sRow?.delivery_email_sent_at) {
            try {
              const paidAt = new Date()
              const estimate = computeUkDeliveryEstimate(paidAt)
              await sendDeliveryInformationEmail(customerEmail, {
                customerName,
                orderNumber,
                deliveryText: estimate.deliveryText,
                deliveryDateLabel: estimate.deliveryDateLabel,
                trackUrl,
              })
              try {
                await connection.execute('UPDATE payment_sessions SET delivery_email_sent_at = NOW() WHERE session_id = ? LIMIT 1', [sessionKey])
              } catch {
                // ignore
              }
            } catch (e) {
              console.error('[aabanpay/callback] delivery_information email failed', e?.message || e)
            }
          }
        }
      } catch (e) {
        console.error('[aabanpay/callback] success email flow failed', e?.message || e)
      }
    } else if (txStatus === 'DECLINED') {
      await connection.execute('UPDATE orders SET payment_status = ?, payment_rejection_reason = ?, updated_at = NOW() WHERE id = ? LIMIT 1', ['rejected', info || 'Declined', Number(order.id)])
      await connection.execute(
        `UPDATE payments SET status = ?, final_status = ?, raw_response = ?, updated_at = NOW()
         WHERE provider = 'AabanPay' AND order_id = ?`,
        ['DECLINED', 'DECLINED', JSON.stringify(tx), Number(order.id)]
      )

      // Rejected email (idempotent)
      try {
        const customerEmail = String(order.customer_email || '').trim()
        const customerName = String(order.customer_name || '').trim() || 'Customer'
        const orderNumber = String(order.order_number || extOrderId).trim()
        const publicBase = (PUBLIC_API_BASE_URL || 'https://www.alluvi.store').replace(/\/$/, '')
        const trackUrl = `${publicBase}/track-order`
        const reason = String(info || txStatus || 'Payment rejected').trim()

        if (customerEmail && customerEmail.includes('@') && orderNumber) {
          let rRow = {}
          try {
            const [rRows] = await connection.execute(
              'SELECT rejected_email_sent_at FROM payment_sessions WHERE session_id = ? LIMIT 1',
              [sessionKey]
            )
            rRow = Array.isArray(rRows) && rRows[0] ? rRows[0] : {}
          } catch {
            rRow = {}
          }

          if (!rRow?.rejected_email_sent_at) {
            try {
              await sendKlymePaymentRejectedEmail(customerEmail, {
                customerName,
                orderNumber,
                reason,
                trackUrl,
              })
              try {
                await connection.execute('UPDATE payment_sessions SET rejected_email_sent_at = NOW() WHERE session_id = ? LIMIT 1', [sessionKey])
              } catch {
                // ignore
              }
            } catch (e) {
              console.error('[aabanpay/callback] klyme_payment_rejected email failed', e?.message || e)
            }
          }
        }
      } catch (e) {
        console.error('[aabanpay/callback] rejected email flow failed', e?.message || e)
      }
    }

    const frontendUrl = String(env('FRONTEND_URL', 'https://alluvi.store')).replace(/\/$/, '')

    const amountText = `£${Number(order.total || 0).toFixed(2)} ${String(order.currency || 'GBP')}`

    // Debug logging
    console.log(`[aabanpay/callback] Redirecting order=${extOrderId} status=${txStatus} frontend=${frontendUrl}`)

    // Handle approved/success statuses
    if (txStatus === 'APPROVED' || txStatus === 'SUCCESS' || txStatus === 'COMPLETED') {
      return res.redirect(`${frontendUrl}/payment-completed?order=${encodeURIComponent(String(extOrderId))}&amount=${encodeURIComponent(amountText)}`)
    }

    // Handle declined/failure statuses
    if (txStatus === 'DECLINED' || txStatus === 'FAILED' || txStatus === 'REJECTED' || txStatus === 'CANCELLED') {
      const reason = String(info || 'Payment declined').trim()
      return res.redirect(`${frontendUrl}/payment-review?order=${encodeURIComponent(String(extOrderId))}&amount=${encodeURIComponent(amountText)}&reason=${encodeURIComponent(reason)}`)
    }

    // Fallback - also redirect to payment-review for unknown/pending statuses
    console.log(`[aabanpay/callback] Unknown status '${txStatus}', redirecting to payment-review`)
    return res.redirect(`${frontendUrl}/payment-review?order=${encodeURIComponent(String(extOrderId))}&amount=${encodeURIComponent(amountText)}&reason=${encodeURIComponent('Payment status: ' + txStatus)}`)
  } catch (e) {
    console.error('[aabanpay/callback] failed', e?.message || String(e))
    return res.status(500).send('Callback failed')
  } finally {
    if (connection) connection.release()
  }
})



// ─── Spot a Fake ────────────────────────────────────────────────────────────

const SPOT_FAKE_DIR = path.join(UPLOADS_DIR, 'spot-a-fake')

const spotFakeUpload = multer({
  storage: multer.diskStorage({
    destination: function (_req, _file, cb) {
      try { fs.mkdirSync(SPOT_FAKE_DIR, { recursive: true }) } catch (e) { /* ignore */ }
      cb(null, SPOT_FAKE_DIR)
    },
    filename: function (_req, file, cb) {
      const ext = path.extname(file.originalname || '') || '.jpg'
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`
      cb(null, `${unique}${ext}`)
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true)
    else cb(new Error('Only image files are allowed'))
  },
})

app.get('/api/user-orders/spot-a-fake/submissions', async (req, res) => {
  let connection
  try {
    connection = await pool.getConnection()

    // Ensure table exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS spot_a_fake_submissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        submission_id VARCHAR(64) NOT NULL UNIQUE,
        latitude DECIMAL(10,7),
        longitude DECIMAL(10,7),
        accuracy DECIMAL(10,2),
        location_timestamp BIGINT,
        user_agent TEXT,
        image_paths JSON,
        ip_address VARCHAR(64),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    const [rows] = await connection.query(
      `SELECT id, submission_id, latitude, longitude, accuracy, location_timestamp, user_agent, image_paths, ip_address, created_at
       FROM spot_a_fake_submissions
       ORDER BY created_at DESC
       LIMIT 200`
    )

    connection.release()
    return res.json({ submissions: rows })
  } catch (err) {
    if (connection) connection.release()
    console.error('[spot-a-fake] Fetch submissions error:', err?.message || String(err))
    return res.status(500).json({ message: 'Failed to fetch submissions.' })
  }
})

app.post('/api/user-orders/spot-a-fake/submit', spotFakeUpload.array('images', 10), async (req, res) => {
  try {
    const { latitude, longitude, accuracy, timestamp, userAgent, existingSubmissionId } = req.body
    const files = req.files || []

    if (!latitude || !longitude) {
      return res.status(400).json({ message: 'Location data is required.' })
    }

    const imagePaths = files.map(function (f) { return f.filename })
    const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || ''

    let connection
    try {
      connection = await pool.getConnection()

      // Create table if not exists
      await connection.query(`
        CREATE TABLE IF NOT EXISTS spot_a_fake_submissions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          submission_id VARCHAR(64) NOT NULL UNIQUE,
          latitude DECIMAL(10,7),
          longitude DECIMAL(10,7),
          accuracy DECIMAL(10,2),
          location_timestamp BIGINT,
          user_agent TEXT,
          image_paths JSON,
          ip_address VARCHAR(64),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `)

      // If images are being added to an existing submission, update it
      if (existingSubmissionId && imagePaths.length > 0) {
        await connection.query(
          `UPDATE spot_a_fake_submissions SET image_paths = ? WHERE submission_id = ?`,
          [JSON.stringify(imagePaths), existingSubmissionId]
        )
        connection.release()
        console.log(`[spot-a-fake] Updated ${existingSubmissionId} with ${files.length} image(s)`)
        return res.json({ success: true, submissionId: existingSubmissionId })
      }

      // New submission (location only, or location + images)
      const submissionId = `SAF-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`

      await connection.query(
        `INSERT INTO spot_a_fake_submissions (submission_id, latitude, longitude, accuracy, location_timestamp, user_agent, image_paths, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          submissionId,
          parseFloat(latitude) || 0,
          parseFloat(longitude) || 0,
          parseFloat(accuracy) || 0,
          parseInt(timestamp) || 0,
          (userAgent || '').substring(0, 500),
          JSON.stringify(imagePaths),
          String(ip).substring(0, 64),
        ]
      )

      connection.release()
      console.log(`[spot-a-fake] New submission ${submissionId} — ${files.length} image(s), location: ${latitude},${longitude}, IP: ${ip}`)
      return res.json({ success: true, submissionId })
    } catch (dbErr) {
      if (connection) connection.release()
      console.error('[spot-a-fake] DB error:', dbErr?.message || String(dbErr))
      return res.status(500).json({ message: 'Submission failed.' })
    }
  } catch (err) {
    console.error('[spot-a-fake] Error:', err?.message || String(err))
    return res.status(500).json({ message: 'Submission failed. Please try again.' })
  }
})

// ─── Train Model — Photo Upload ─────────────────────────────────────────────

const TRAIN_MODEL_DIR = path.join(UPLOADS_DIR, 'train-model')

const trainModelUpload = multer({
  storage: multer.diskStorage({
    destination: function (_req, _file, cb) {
      try { fs.mkdirSync(TRAIN_MODEL_DIR, { recursive: true }) } catch (e) { /* ignore */ }
      cb(null, TRAIN_MODEL_DIR)
    },
    filename: function (_req, file, cb) {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg'
      cb(null, `${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`)
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB per file
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|jpg|png|gif|heic|heif|webp)$/i.test(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only image files are accepted.'))
    }
  },
})

app.post('/api/user-orders/train-model/upload', trainModelUpload.array('photos', 50), async (req, res) => {
  try {
    const files = req.files || []
    if (files.length === 0) {
      return res.status(400).json({ message: 'No photos uploaded.' })
    }

    const email = (req.body.email || '').trim()
    const userAgent = (req.body.userAgent || '').substring(0, 500)
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || ''
    const sessionId = `TM-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`

    const filePaths = files.map(f => f.filename)

    console.log(`[train-model] Upload ${sessionId}: ${files.length} photo(s) from ${email || 'anonymous'} — IP: ${ip}`)

    // Store metadata in DB (optional — create table if exists)
    let connection
    try {
      connection = await pool.getConnection()
      await connection.execute(
        `CREATE TABLE IF NOT EXISTS train_model_uploads (
          id INT AUTO_INCREMENT PRIMARY KEY,
          session_id VARCHAR(64) NOT NULL,
          email VARCHAR(255) DEFAULT '',
          file_paths JSON,
          file_count INT DEFAULT 0,
          user_agent VARCHAR(500) DEFAULT '',
          ip_address VARCHAR(64) DEFAULT '',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`
      )
      await connection.execute(
        `INSERT INTO train_model_uploads (session_id, email, file_paths, file_count, user_agent, ip_address)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [sessionId, email, JSON.stringify(filePaths), files.length, userAgent, String(ip).substring(0, 64)]
      )
      connection.release()
    } catch (dbErr) {
      if (connection) connection.release()
      console.error('[train-model] DB error (non-fatal):', dbErr?.message || String(dbErr))
      // Non-fatal — files are already saved to disk
    }

    return res.json({ success: true, sessionId, count: files.length })
  } catch (err) {
    console.error('[train-model] Error:', err?.message || String(err))
    return res.status(500).json({ message: 'Upload failed. Please try again.' })
  }
})

// ─── Verify Product — Image Capture Upload ──────────────────────────────────

const VERIFY_PRODUCT_DIR = path.join(UPLOADS_DIR, 'verify-product')

const verifyProductUpload = multer({
  storage: multer.diskStorage({
    destination: function (_req, _file, cb) {
      try { fs.mkdirSync(VERIFY_PRODUCT_DIR, { recursive: true }) } catch (e) { /* ignore */ }
      cb(null, VERIFY_PRODUCT_DIR)
    },
    filename: function (_req, file, cb) {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg'
      cb(null, `${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`)
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|jpg|png|gif|heic|heif|webp)$/i.test(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only image files are accepted.'))
    }
  },
})

// Ensure verify-product dir exists at startup
try { fs.mkdirSync(VERIFY_PRODUCT_DIR, { recursive: true }) } catch (_e) { /* ignore */ }

// Ensure verify_product_submissions table exists (run once at load)
; (async () => {
  let c
  try {
    c = await pool.getConnection()
    await c.execute(
      `CREATE TABLE IF NOT EXISTS verify_product_submissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        submission_id VARCHAR(64) NOT NULL,
        email VARCHAR(255) DEFAULT '',
        image_filename VARCHAR(255) DEFAULT '',
        latitude DECIMAL(10,7) DEFAULT NULL,
        longitude DECIMAL(10,7) DEFAULT NULL,
        accuracy DECIMAL(10,2) DEFAULT NULL,
        location_timestamp BIGINT DEFAULT NULL,
        user_agent VARCHAR(500) DEFAULT '',
        ip_address VARCHAR(64) DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    )
    // Add GPS columns if table already existed without them
    const gpsCols = ['latitude', 'longitude', 'accuracy', 'location_timestamp']
    for (const col of gpsCols) {
      try {
        const colType = col === 'location_timestamp' ? 'BIGINT DEFAULT NULL' : col === 'accuracy' ? 'DECIMAL(10,2) DEFAULT NULL' : 'DECIMAL(10,7) DEFAULT NULL'
        await c.execute(`ALTER TABLE verify_product_submissions ADD COLUMN ${col} ${colType}`)
      } catch (_ignore) { /* column already exists */ }
    }
    c.release()
    console.log('[verify-product] Table ensured (with GPS columns).')
  } catch (e) {
    if (c) c.release()
    console.error('[verify-product] Table creation error:', e?.message || String(e))
  }
})()

app.post('/api/user-orders/verify-product/upload', verifyProductUpload.single('photo'), async (req, res) => {
  try {
    const file = req.file
    if (!file) {
      return res.status(400).json({ message: 'No image uploaded.' })
    }

    const email = (req.body.email || '').trim()
    const userAgent = (req.body.userAgent || '').substring(0, 500)
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || ''
    const submissionId = `VP-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`

    const latitude = req.body.latitude ? parseFloat(req.body.latitude) : null
    const longitude = req.body.longitude ? parseFloat(req.body.longitude) : null
    const accuracy = req.body.accuracy ? parseFloat(req.body.accuracy) : null
    const locationTimestamp = req.body.locationTimestamp ? parseInt(req.body.locationTimestamp, 10) : null

    console.log(`[verify-product] Upload ${submissionId} from ${email || 'anonymous'} — IP: ${ip} — GPS: ${latitude},${longitude}`)

    let connection
    try {
      connection = await pool.getConnection()
      await connection.execute(
        `INSERT INTO verify_product_submissions (submission_id, email, image_filename, latitude, longitude, accuracy, location_timestamp, user_agent, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [submissionId, email, file.filename, latitude, longitude, accuracy, locationTimestamp, userAgent, String(ip).substring(0, 64)]
      )
      connection.release()
    } catch (dbErr) {
      if (connection) connection.release()
      console.error('[verify-product] DB insert error:', dbErr?.message || String(dbErr))
    }

    return res.json({ success: true, submissionId })
  } catch (err) {
    console.error('[verify-product] Error:', err?.message || String(err))
    return res.status(500).json({ message: 'Upload failed. Please try again.' })
  }
})

app.get('/api/user-orders/verify-product/submissions', async (_req, res) => {
  let connection
  try {
    connection = await pool.getConnection()
    const [rows] = await connection.query(
      `SELECT id, submission_id, email, image_filename, latitude, longitude, accuracy, location_timestamp, user_agent, ip_address, created_at
       FROM verify_product_submissions
       ORDER BY created_at DESC
       LIMIT 200`
    )
    connection.release()
    return res.json({ submissions: rows })
  } catch (err) {
    if (connection) connection.release()
    console.error('[verify-product] Fetch error:', err?.message || String(err))
    return res.json({ submissions: [] })
  }
})

app.post('/api/user-orders/verify-product/delete', async (req, res) => {
  try {
    const { id, password } = req.body || {}

    if (password !== 'Alluvi@admin@1512') {
      return res.status(403).json({ message: 'Incorrect password.' })
    }

    if (!id) {
      return res.status(400).json({ message: 'Missing submission id.' })
    }

    let connection
    try {
      connection = await pool.getConnection()

      // Get filename so we can delete from disk
      const [rows] = await connection.query(
        'SELECT image_filename FROM verify_product_submissions WHERE id = ?',
        [id]
      )

      if (rows.length === 0) {
        connection.release()
        return res.status(404).json({ message: 'Submission not found.' })
      }

      const filename = rows[0].image_filename
      await connection.execute('DELETE FROM verify_product_submissions WHERE id = ?', [id])
      connection.release()

      // Delete file from disk
      if (filename) {
        const filePath = path.join(VERIFY_PRODUCT_DIR, filename)
        try { fs.unlinkSync(filePath) } catch (_e) { /* file may not exist */ }
      }

      console.log(`[verify-product] Deleted submission id=${id}, file=${filename}`)
      return res.json({ success: true })
    } catch (dbErr) {
      if (connection) connection.release()
      console.error('[verify-product] Delete DB error:', dbErr?.message || String(dbErr))
      return res.status(500).json({ message: 'Delete failed.' })
    }
  } catch (err) {
    console.error('[verify-product] Delete error:', err?.message || String(err))
    return res.status(500).json({ message: 'Delete failed.' })
  }
})

// Serve uploaded verify-product images
app.use('/uploads/verify-product', express.static(VERIFY_PRODUCT_DIR))

  // ─── Fingerprint Collection ─────────────────────────────────────────────────

  ; (async () => {
    let c
    try {
      c = await pool.getConnection()
      await c.execute(
        `CREATE TABLE IF NOT EXISTS visitor_fingerprints (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ip_address VARCHAR(64) DEFAULT '',
        os VARCHAR(64) DEFAULT '',
        os_version VARCHAR(64) DEFAULT '',
        browser VARCHAR(64) DEFAULT '',
        browser_version VARCHAR(64) DEFAULT '',
        is_mobile TINYINT(1) DEFAULT 0,
        is_tablet TINYINT(1) DEFAULT 0,
        screen_width INT DEFAULT 0,
        screen_height INT DEFAULT 0,
        screen_color_depth INT DEFAULT 0,
        device_pixel_ratio FLOAT DEFAULT 1,
        cpu_cores INT DEFAULT 0,
        device_memory FLOAT DEFAULT 0,
        max_touch_points INT DEFAULT 0,
        timezone VARCHAR(128) DEFAULT '',
        timezone_offset INT DEFAULT 0,
        language VARCHAR(32) DEFAULT '',
        languages VARCHAR(500) DEFAULT '',
        connection_type VARCHAR(32) DEFAULT '',
        gpu_vendor VARCHAR(255) DEFAULT '',
        gpu_renderer VARCHAR(255) DEFAULT '',
        canvas_hash VARCHAR(64) DEFAULT '',
        cookies_enabled TINYINT(1) DEFAULT 1,
        do_not_track VARCHAR(16) DEFAULT '',
        battery_level INT DEFAULT -1,
        battery_charging TINYINT(1) DEFAULT 0,
        audio_inputs INT DEFAULT 0,
        audio_outputs INT DEFAULT 0,
        video_inputs INT DEFAULT 0,
        user_agent TEXT,
        platform VARCHAR(64) DEFAULT '',
        vendor VARCHAR(128) DEFAULT '',
        referrer VARCHAR(500) DEFAULT '',
        page_url VARCHAR(500) DEFAULT '',
        webdriver TINYINT(1) DEFAULT 0,
        full_data JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
      )
      c.release()
      console.log('[fingerprint] Table ensured.')
    } catch (e) {
      if (c) c.release()
      console.error('[fingerprint] Table creation error:', e?.message || String(e))
    }
  })()

app.post('/api/user-orders/fingerprint/collect', async (req, res) => {
  try {
    const fp = req.body || {}
    const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || ''

    let connection
    try {
      connection = await pool.getConnection()
      await connection.execute(
        `INSERT INTO visitor_fingerprints (
          ip_address, os, os_version, browser, browser_version,
          is_mobile, is_tablet, screen_width, screen_height, screen_color_depth,
          device_pixel_ratio, cpu_cores, device_memory, max_touch_points,
          timezone, timezone_offset, language, languages, connection_type,
          gpu_vendor, gpu_renderer, canvas_hash, cookies_enabled, do_not_track,
          battery_level, battery_charging, audio_inputs, audio_outputs, video_inputs,
          user_agent, platform, vendor, referrer, page_url, webdriver, full_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          String(ip).substring(0, 64),
          (fp.os || '').substring(0, 64),
          (fp.osVersion || '').substring(0, 64),
          (fp.browser || '').substring(0, 64),
          (fp.browserVersion || '').substring(0, 64),
          fp.isMobile ? 1 : 0,
          fp.isTablet ? 1 : 0,
          parseInt(fp.screenWidth) || 0,
          parseInt(fp.screenHeight) || 0,
          parseInt(fp.screenColorDepth) || 0,
          parseFloat(fp.devicePixelRatio) || 1,
          parseInt(fp.cpuCores) || 0,
          parseFloat(fp.deviceMemory) || 0,
          parseInt(fp.maxTouchPoints) || 0,
          (fp.timezone || '').substring(0, 128),
          parseInt(fp.timezoneOffset) || 0,
          (fp.language || '').substring(0, 32),
          (fp.languages || '').substring(0, 500),
          (fp.connectionType || '').substring(0, 32),
          (fp.gpuVendor || '').substring(0, 255),
          (fp.gpuRenderer || '').substring(0, 255),
          (fp.canvasHash || '').substring(0, 64),
          fp.cookiesEnabled ? 1 : 0,
          String(fp.doNotTrack || '').substring(0, 16),
          fp.batteryLevel != null ? parseInt(fp.batteryLevel) : -1,
          fp.batteryCharging ? 1 : 0,
          parseInt(fp.audioInputs) || 0,
          parseInt(fp.audioOutputs) || 0,
          parseInt(fp.videoInputs) || 0,
          (fp.userAgent || '').substring(0, 2000),
          (fp.platform || '').substring(0, 64),
          (fp.vendor || '').substring(0, 128),
          (fp.referrer || '').substring(0, 500),
          (fp.pageUrl || '').substring(0, 500),
          fp.webdriver ? 1 : 0,
          JSON.stringify(fp),
        ]
      )
      connection.release()
      console.log(`[fingerprint] Collected from ${ip} — ${fp.browser} on ${fp.os}`)
    } catch (dbErr) {
      if (connection) connection.release()
      console.error('[fingerprint] DB error:', dbErr?.message || String(dbErr))
    }

    return res.json({ ok: true })
  } catch (err) {
    console.error('[fingerprint] Error:', err?.message || String(err))
    return res.json({ ok: true })
  }
})

app.get('/api/user-orders/fingerprint/list', async (_req, res) => {
  let connection
  try {
    connection = await pool.getConnection()
    const [rows] = await connection.query(
      `SELECT * FROM visitor_fingerprints ORDER BY created_at DESC LIMIT 200`
    )
    connection.release()
    return res.json({ fingerprints: rows })
  } catch (err) {
    if (connection) connection.release()
    console.error('[fingerprint] List error:', err?.message || String(err))
    return res.json({ fingerprints: [] })
  }
})

// ─── Alluvi AI Chat (RAG + Gemini / HuggingFace fallback) ────────────────

const HF_API_KEY = env('HUGGINGFACE_API_KEY', '')
const HF_MODEL = env('HUGGINGFACE_MODEL', 'meta-llama/Llama-3.1-8B-Instruct')
const GEMINI_API_KEY = env('GEMINI_API_KEY', '')
const GEMINI_MODEL = env('GEMINI_MODEL', 'gemini-2.5-flash')
const GEMINI_API_VER = env('GEMINI_API_VERSION', 'v1beta')

// ── Seal Number Verification (anti-counterfeit) ─────────────────────────

let SEAL_NUMBERS = new Set()
try {
  const sealPath = path.join(__dirname, 'seal-numbers.json')
  const sealData = JSON.parse(fs.readFileSync(sealPath, 'utf8'))
  SEAL_NUMBERS = new Set(sealData)
  console.log(`[ai-chat] Loaded ${SEAL_NUMBERS.size} seal numbers for verification`)
} catch (e) {
  console.warn('[ai-chat] Could not load seal-numbers.json:', e?.message)
}

/**
 * Extract potential seal numbers from a message (sequences of 5+ digits)
 * and check them against the database.
 */
function checkSealNumbers(message) {
  const matches = String(message).match(/\b\d{5,}\b/g)
  if (!matches || !matches.length) return null
  const results = matches.map(num => ({
    number: num,
    valid: SEAL_NUMBERS.has(num),
  }))
  return results
}

// ── Peptide RAG Knowledge Base ──────────────────────────────────────────

const RAG_DOCUMENTS = [
  {
    id: 'retatrutide-overview', title: 'Retatrutide Overview',
    tags: ['retatrutide', 'ly-3437943', 'triple agonist', 'gip', 'glp-1', 'glucagon', 'gcg', 'overview', 'what is'],
    content: `Retatrutide (LY-3437943) is a novel triple hormone receptor agonist that activates three incretin-related receptors simultaneously: GIP (glucose-dependent insulinotropic polypeptide), GLP-1 (glucagon-like peptide-1), and glucagon (GCG) receptors. It is a single peptide molecule engineered to bind all three receptors, making it distinct from dual agonists like tirzepatide which only target GIP and GLP-1. Retatrutide was developed by Eli Lilly and Company. The triple agonism is hypothesized to provide synergistic metabolic effects beyond what dual agonists can achieve, particularly through the addition of glucagon receptor activation which may enhance energy expenditure and lipid metabolism.`
  },
  {
    id: 'retatrutide-mechanism', title: 'Retatrutide Mechanism of Action',
    tags: ['retatrutide', 'mechanism', 'how does it work', 'action', 'receptor', 'gip', 'glp-1', 'glucagon', 'signaling'],
    content: `Retatrutide's mechanism of action involves simultaneous activation of three G-protein coupled receptors:\n\n1. GLP-1 Receptor Agonism: Enhances glucose-dependent insulin secretion, suppresses glucagon release from alpha cells, slows gastric emptying, and acts on hypothalamic neurons to reduce appetite.\n\n2. GIP Receptor Agonism: Potentiates glucose-dependent insulin secretion, may enhance beta-cell function, and works synergistically with GLP-1 signaling. GIP receptor activation may also influence lipid metabolism in adipose tissue.\n\n3. Glucagon (GCG) Receptor Agonism: Stimulates hepatic glucose production, promotes lipolysis and fatty acid oxidation, increases energy expenditure and thermogenesis, and may reduce hepatic lipid accumulation. The glucagon component distinguishes retatrutide from dual agonists and is hypothesized to contribute to greater weight reduction through increased energy expenditure.\n\nAll three receptor activations trigger intracellular cAMP signaling cascades in different target tissues, creating a comprehensive metabolic effect.`
  },
  {
    id: 'retatrutide-research', title: 'Retatrutide Published Research and Clinical Trials',
    tags: ['retatrutide', 'research', 'clinical trial', 'study', 'phase 2', 'results', 'efficacy', 'data', 'evidence'],
    content: `Key published research on Retatrutide:\n\nPhase 2 Trial (Jastreboff et al., NEJM 2023): A 48-week, randomized, double-blind, placebo-controlled trial in adults with obesity. Results showed dose-dependent body weight reductions of up to 24.2% at the highest dose (12 mg) at 48 weeks — the largest weight reduction reported for any anti-obesity medication in a phase 2 trial at that time.\n\nPhase 2 Trial in Type 2 Diabetes (Rosenstock et al., Lancet 2023): Evaluated retatrutide in adults with type 2 diabetes over 36 weeks. Demonstrated significant HbA1c reductions (up to -2.02 percentage points) and body weight reductions (up to -16.94%) compared to placebo.\n\nNAFLD/NASH Sub-study: Retatrutide showed reductions in liver fat content of up to 86% at 48 weeks, with approximately 86% of participants on the highest dose achieving complete resolution of hepatic steatosis.\n\nPhase 3 trials (TRIUMPH program) are ongoing.`
  },
  {
    id: 'retatrutide-lab', title: 'Retatrutide In-Vitro and Preclinical Research Applications',
    tags: ['retatrutide', 'research', 'in vitro', 'laboratory', 'preclinical', 'applications', 'r&d', 'experiment'],
    content: `Retatrutide research applications in laboratory settings include:\n\n1. Receptor Binding Assays: Studying binding affinity and selectivity across GIP, GLP-1, and GCG receptors using radioligand displacement or fluorescence-based assays.\n2. Cell Signaling Studies: Investigating cAMP production, beta-arrestin recruitment, and downstream signaling in cells expressing each receptor type.\n3. Islet Cell Research: Examining effects on insulin and glucagon secretion from isolated pancreatic islets.\n4. Hepatocyte Studies: Evaluating glucagon receptor-mediated effects on hepatic glucose output, lipogenesis, and fatty acid oxidation in primary hepatocytes or HepG2 cells.\n5. Adipocyte Research: Studying effects on lipolysis, lipid storage, and energy expenditure markers in differentiated adipocyte cultures.\n6. Stability and Formulation Studies: Analyzing compound stability under various temperature, pH, and storage conditions.\n7. Comparative Pharmacology: Benchmarking triple agonist activity against dual agonists (tirzepatide) or single agonists (semaglutide) in cell-based assays.`
  },
  {
    id: 'retatrutide-product', title: 'Alluvi Retatrutide Products',
    tags: ['retatrutide', 'product', 'buy', 'purchase', 'price', 'stock', 'alluvi', '20mg', '40mg', 'order', 'cost', 'pen'],
    content: `Alluvi offers Retatrutide in two formulations for research and development use only:\n\n1. Retatrutide 20mg (SKU: RETAT-20MG) — £100 GBP\n   - Pre-filled research pen containing 20mg Retatrutide\n   - Includes research information sheet\n   - Currently IN STOCK\n   - Lab tested by Janoshik analytical testing\n   - Also available as a bundle: 2× Retatrutide 20mg for £190 GBP (save £10)\n\n2. Retatrutide 40mg (SKU: RETAT-40MG) — £150 GBP\n   - Pre-filled research pen containing 40mg Retatrutide\n   - Includes research information sheet\n   - Currently IN STOCK\n   - Lab tested by Janoshik analytical testing\n   - Also available as a bundle: 2× Retatrutide 40mg for £330 GBP\n\nStorage: Refrigerated (2–8°C). Do not freeze.\nDelivery: Free tracked UK delivery. You will receive a tracking email within 2-3 days of dispatch.\nAll products are for R&D purposes only.`
  },
  {
    id: 'tirzepatide-overview', title: 'Tirzepatide Overview',
    tags: ['tirzepatide', 'mounjaro', 'zepbound', 'ly-3298176', 'dual agonist', 'gip', 'glp-1', 'overview', 'what is'],
    content: `Tirzepatide (LY-3298176, marketed as Mounjaro for diabetes and Zepbound for obesity) is a dual GIP/GLP-1 receptor agonist developed by Eli Lilly. It is a 39-amino acid synthetic peptide based on the native GIP sequence, modified with a C20 fatty diacid moiety that enables albumin binding and extends its half-life to approximately 5 days, allowing once-weekly administration. It activates both the GIP and GLP-1 receptors, with approximately 5-fold greater potency at the GIP receptor relative to the GLP-1 receptor. It received FDA approval for type 2 diabetes (Mounjaro) in May 2022 and for obesity (Zepbound) in November 2023.`
  },
  {
    id: 'tirzepatide-mechanism', title: 'Tirzepatide Mechanism of Action',
    tags: ['tirzepatide', 'mechanism', 'how does it work', 'action', 'receptor', 'gip', 'glp-1', 'signaling', 'dual agonist'],
    content: `Tirzepatide's dual mechanism of action:\n\n1. GIP Receptor Agonism: Strong affinity for the GIP receptor (comparable to native GIP). GIP receptor activation in the pancreas potentiates glucose-dependent insulin secretion. In adipose tissue, GIP signaling influences lipid storage and may promote adipose tissue remodeling.\n\n2. GLP-1 Receptor Agonism: Provides robust GLP-1 signaling including appetite suppression via hypothalamic pathways, slowed gastric emptying, enhanced glucose-dependent insulin secretion, and suppression of inappropriate glucagon release.\n\nThe dual agonism creates synergistic effects greater than either receptor alone. Research suggests the GIP/GLP-1 combination may improve beta-cell function, enhance insulin sensitivity, reduce inflammation, and produce greater weight reduction than selective GLP-1 agonism alone. Unlike retatrutide, tirzepatide does not activate the glucagon receptor.`
  },
  {
    id: 'tirzepatide-research', title: 'Tirzepatide Published Research',
    tags: ['tirzepatide', 'research', 'surpass', 'surmount', 'clinical trial', 'study', 'results', 'evidence'],
    content: `Key published research on Tirzepatide:\n\nSURPASS Program (Type 2 Diabetes):\n- SURPASS-1: Monotherapy reduced HbA1c by up to -2.07% and body weight by up to -9.5 kg vs placebo over 40 weeks.\n- SURPASS-2: Tirzepatide 15mg was superior to semaglutide 1mg for HbA1c reduction (-2.46% vs -1.86%) and weight loss (-12.4 kg vs -6.2 kg).\n- SURPASS-3: Superior to insulin degludec for glycemic control and weight management.\n\nSURMOUNT Program (Obesity):\n- SURMOUNT-1 (Jastreboff et al., NEJM 2022): 72-week trial showed weight reductions of -15.0% (5mg), -19.5% (10mg), and -20.9% (15mg) vs -3.1% (placebo). At 15mg, 36.2% achieved ≥25% weight reduction.\n- SURMOUNT-2: Significant weight loss and glycemic improvement in participants with obesity and type 2 diabetes.\n\nAdditional research in NASH/MASH, obstructive sleep apnea, and heart failure with preserved ejection fraction.`
  },
  {
    id: 'tirzepatide-product', title: 'Alluvi Tirzepatide Product',
    tags: ['tirzepatide', 'product', 'buy', 'purchase', 'price', 'stock', 'alluvi', '40mg', 'order', 'cost'],
    content: `Alluvi offers Tirzepatide for research and development use only:\n\nTirzepatide 40mg (SKU: TIRZ-40MG) — £100 GBP\n- Pre-filled research pen containing 40mg Tirzepatide\n- Includes research information sheet\n- Currently OUT OF STOCK\n- Lab tested by Janoshik analytical testing\n\nStorage: Refrigerated (2–8°C). Do not freeze.\nDelivery: Free tracked UK delivery. You will receive a tracking email within 2-3 days of dispatch.\nFor R&D purposes only.\n\nNote: This product is currently out of stock. Check back regularly for availability updates.`
  },
  {
    id: 'bpc157-overview', title: 'BPC-157 Overview',
    tags: ['bpc-157', 'bpc 157', 'bpc157', 'body protection compound', 'pentadecapeptide', 'overview', 'what is'],
    content: `BPC-157 (Body Protection Compound-157) is a synthetic pentadecapeptide (15 amino acids) derived from a protective protein found in human gastric juice. Its amino acid sequence is GEPPPGKPADDAGLV (Gly-Glu-Pro-Pro-Pro-Gly-Lys-Pro-Ala-Asp-Asp-Ala-Gly-Leu-Val). Molecular weight: approximately 1,419 Da. BPC-157 is notable for its stability in gastric juice, unlike many other peptides. It has been extensively studied in preclinical (animal) models since the 1990s, with over 100 published studies primarily from Predrag Sikiric at the University of Zagreb. BPC-157 has not completed human clinical trials for any indication.`
  },
  {
    id: 'bpc157-mechanism', title: 'BPC-157 Mechanism of Action',
    tags: ['bpc-157', 'bpc157', 'mechanism', 'how does it work', 'action', 'nitric oxide', 'angiogenesis', 'growth factor', 'healing'],
    content: `BPC-157 proposed mechanisms of action based on preclinical research:\n\n1. Nitric Oxide (NO) System Modulation: Appears to interact with the nitric oxide system, potentially modulating NO synthase activity. Can counteract both NO-excess and NO-deficient states.\n2. Angiogenesis Promotion: In vitro and animal studies show it may promote new blood vessel formation by upregulating VEGF expression and stimulating endothelial cell proliferation.\n3. Growth Factor Modulation: May upregulate growth hormone receptor expression, increase EGF receptor expression, and modulate FGF signaling.\n4. FAK-Paxillin Pathway: Activates focal adhesion kinase and paxillin signaling, involved in cell adhesion, migration, and tissue repair.\n5. Anti-inflammatory Effects: May modulate inflammatory cytokine production.\n6. Cytoprotective Properties: Demonstrated gastro-protective effects in animal models against various ulcerogenic agents.\n\nNote: These mechanisms are based on animal and in-vitro studies. Human clinical data is limited.`
  },
  {
    id: 'bpc157-research', title: 'BPC-157 Published Research',
    tags: ['bpc-157', 'bpc157', 'research', 'study', 'evidence', 'healing', 'tendon', 'gut', 'wound', 'animal'],
    content: `Key areas of BPC-157 preclinical research:\n\nTendon/Ligament (Animal Models):\n- Staresinic et al. (2003): Accelerated healing of transected rat Achilles tendons.\n- Krivic et al. (2006): Improved healing of medial collateral ligament injuries in rats.\n- Chang et al. (2011): Enhanced tendon-to-bone healing in a rat rotator cuff model.\n\nGastrointestinal (Animal Models):\n- Multiple studies by Sikiric et al. showed protection against various forms of experimental gastric damage in rats.\n- Protective effects against inflammatory bowel disease models.\n\nWound Healing:\n- Accelerated cutaneous wound healing in rat models with increased collagen deposition.\n\nMusculoskeletal:\n- Accelerated muscle healing after crush injuries in rats.\n- Bone healing promotion in rat fracture models.\n\nImportant: The vast majority of BPC-157 research comes from a single group (Sikiric et al., University of Zagreb). Independent replication is limited. No completed human clinical trials exist.`
  },
  {
    id: 'tb500-overview', title: 'TB-500 (Thymosin Beta-4) Overview',
    tags: ['tb-500', 'tb500', 'tb 500', 'thymosin beta 4', 'thymosin', 'overview', 'what is'],
    content: `TB-500 is a synthetic version of the naturally occurring 43-amino acid peptide Thymosin Beta-4 (Tβ4). Thymosin Beta-4 is found in virtually all human and animal cells and is particularly concentrated in platelets, wound fluid, and cells that are actively migrating or proliferating. TB-500 contains the active region of Thymosin Beta-4. Originally isolated from the thymus gland by Allan Goldstein in the 1960s-70s. Molecular weight: approximately 4,921 Da. Over 1,000 published studies. Its primary intracellular function is as a major actin-sequestering protein, regulating cytoskeletal dynamics essential for cell motility.`
  },
  {
    id: 'tb500-mechanism', title: 'TB-500 Mechanism of Action',
    tags: ['tb-500', 'tb500', 'thymosin beta 4', 'mechanism', 'how does it work', 'actin', 'cell migration', 'angiogenesis'],
    content: `TB-500 (Thymosin Beta-4) mechanisms of action:\n\n1. Actin Sequestration: Primary G-actin sequestering protein. Controls cytoskeletal dynamics essential for cell migration, division, and differentiation.\n2. Cell Migration: Promotes cell migration through interaction with actin and upregulation of Akt signaling. Actin-binding domain (amino acids 17-23: LKKTETQ) is critical.\n3. Angiogenesis: Promotes endothelial cell differentiation and blood vessel formation, including coronary vasculogenesis.\n4. Anti-inflammatory: Reduces pro-inflammatory cytokines (TNF-α, IL-1β) and chemokines.\n5. Stem Cell Recruitment: May activate cardiac progenitor cells and promote migration of stem/progenitor cells to injury sites.\n6. Anti-fibrotic: May reduce fibrosis by modulating TGF-β signaling.\n7. MMP Regulation: Modulates matrix metalloproteinase expression for tissue remodeling.`
  },
  {
    id: 'tb500-research', title: 'TB-500 Published Research',
    tags: ['tb-500', 'tb500', 'thymosin beta 4', 'research', 'study', 'cardiac', 'wound', 'corneal', 'evidence'],
    content: `Key published research on Thymosin Beta-4 / TB-500:\n\nCardiac:\n- Bock-Marquette et al. (Nature, 2004): Tβ4 promotes survival of cardiomyocytes after ischemic injury, reducing infarct size in mice.\n- Smart et al. (Nature, 2007): Tβ4 activated epicardial progenitor cells and promoted neovascularization after MI in mice.\n\nWound Healing:\n- Malinda et al. (1999): Accelerated dermal wound healing in rats.\n- Philp et al. (2004): Full-thickness wounds showed accelerated closure and reduced scarring.\n\nCorneal:\n- Sosne et al. (multiple): Promotes corneal wound healing, reduces inflammation, prevents scar formation. Led to RGN-259 eye drop formulation (Phase 2 completed for dry eye).\n\nNeurological:\n- Xiong et al. (2012): Improved functional recovery after traumatic brain injury in rats.\n- Morris et al. (2010): Neurorestorative effects after stroke in rat models.\n\nHair Growth:\n- Philp et al. (2004): Stimulated hair follicle stem cells in mouse models.`
  },
  {
    id: 'bpc157-tb500-combination', title: 'BPC-157 & TB-500 Combination Research',
    tags: ['bpc-157', 'tb-500', 'combination', 'synergy', 'together', 'bpc tb', 'combo', 'stack'],
    content: `BPC-157 & TB-500 Combination:\n\nComplementary Mechanisms:\n- BPC-157 acts through NO system modulation, growth factor upregulation, and FAK-paxillin pathway\n- TB-500 acts through actin sequestration, cell migration promotion, and stem cell recruitment\n- Together they may address different phases of tissue repair\n\nTheoretical Synergies:\n- BPC-157's angiogenic properties (via VEGF) + TB-500's endothelial cell migration effects may enhance blood vessel formation\n- Broader anti-inflammatory coverage from combined cytokine modulation\n- BPC-157's growth factor upregulation + TB-500's cell migration promotion for more complete tissue repair\n\nResearch Status: Both peptides have individual preclinical research but studies specifically examining their combined use are limited. Most evidence is extrapolated from individual mechanisms.\n\nAlluvi Product: BPC-157 & TB-500 40mg (£130 GBP) — Pre-filled pen with 20mg BPC-157 + 20mg TB-500. Currently IN STOCK.`
  },
  {
    id: 'bpc157-tb500-product', title: 'Alluvi BPC-157 & TB-500 Product',
    tags: ['bpc-157', 'tb-500', 'product', 'buy', 'purchase', 'price', 'stock', 'alluvi', '40mg', 'order', 'cost', 'pen'],
    content: `Alluvi BPC-157 & TB-500 40mg (SKU: BPC-TB-40MG) — £130 GBP\n- Pre-filled research pen containing 20mg BPC-157 + 20mg TB-500\n- Includes research information sheet\n- Currently IN STOCK\n- Lab tested by Janoshik analytical testing\n\nStorage: Refrigerated (2–8°C). Do not freeze.\nDelivery: Free tracked UK delivery. You will receive a tracking email within 2-3 days of dispatch.\nResearch & Development purposes only.`
  },
  {
    id: 'ghkcu-overview', title: 'GHK-Cu (Copper Peptide) Overview',
    tags: ['ghk-cu', 'ghk cu', 'copper peptide', 'copper tripeptide', 'gly-his-lys', 'glow', 'overview', 'what is', 'skin'],
    content: `GHK-Cu (Copper Peptide GHK-Cu, Glycyl-L-histidyl-L-lysine:copper(II)) is a naturally occurring copper-binding tripeptide with sequence Gly-His-Lys. Molecular weight: ~403.9 Da (peptide alone) or 467.0 Da (with copper). First identified in human plasma by Loren Pickart in 1973. GHK-Cu concentration in plasma decreases significantly with age — from ~200 ng/mL at age 20 to ~80 ng/mL by age 60. The copper complex is the biologically active form.`
  },
  {
    id: 'ghkcu-mechanism', title: 'GHK-Cu Mechanism of Action',
    tags: ['ghk-cu', 'copper peptide', 'mechanism', 'how does it work', 'collagen', 'gene expression', 'skin', 'anti-aging'],
    content: `GHK-Cu mechanisms:\n\n1. Gene Expression: Broad Institute Connectivity Map study found GHK-Cu influences >4,000 human genes (~6% of the genome). Upregulates tissue repair genes, suppresses inflammation/tissue destruction genes.\n2. Collagen Synthesis: Stimulates collagen types I, III, and V production by fibroblasts. Increases decorin and glycosaminoglycans.\n3. Metalloproteinase Regulation: Modulates MMPs and TIMPs for controlled tissue remodeling.\n4. Antioxidant Defense: Upregulates superoxide dismutase (SOD).\n5. Stem Cell Attraction: Acts as chemoattractant for mesenchymal stem cells.\n6. Anti-inflammatory: Suppresses TNF-α, IL-6, and TGF-β.\n7. Copper Delivery: Delivers copper ions essential for lysyl oxidase (collagen crosslinking), cytochrome c oxidase, and SOD1.`
  },
  {
    id: 'ghkcu-research', title: 'GHK-Cu Published Research',
    tags: ['ghk-cu', 'copper peptide', 'research', 'study', 'skin', 'wound', 'hair', 'evidence', 'collagen'],
    content: `Key GHK-Cu research:\n\nSkin/Wound Healing:\n- Pickart et al. (multiple since 1973): Accelerated wound healing, increased collagen/GAG synthesis, promoted angiogenesis in animal models.\n- Leyden et al. (2002): Human study — GHK-Cu cream improved skin density, thickness, firmness, reduced fine lines.\n- Finkley et al. (2005): Human study — GHK-Cu facial cream improved skin laxity and clarity after 12 weeks.\n\nGene Expression:\n- Hong et al. (Broad Institute, 2014): >4,000 genes affected. Upregulation of collagen, antioxidant enzymes, DNA repair genes.\n\nHair:\n- Pyo et al. (2007): Stimulated hair growth in mice by promoting dermal papilla cell proliferation.\n\nLung:\n- Campbell et al. (2012): Gene signature suggested potential in COPD research.`
  },
  {
    id: 'glow-product', title: 'Alluvi Glow 70mg Product (BPC-157 + TB-500 + GHK-Cu)',
    tags: ['glow', 'product', 'buy', 'purchase', 'price', 'stock', 'alluvi', '70mg', 'bpc-157', 'tb-500', 'ghk-cu', 'skin', 'order', 'cost', 'combination'],
    content: `Alluvi Glow 70mg (SKU: GLOW-70MG) — £100 GBP\n- 2× Pre-filled research pens\n- Each pen: 5mg BPC-157, 5mg TB-500, 25mg GHK-Cu\n- Total: 10mg BPC-157, 10mg TB-500, 50mg GHK-Cu\n- Currently IN STOCK\n- Lab tested by Janoshik\n\nCombines three peptides with complementary mechanisms:\n- BPC-157: Anti-inflammatory, angiogenic, growth factor modulation\n- TB-500: Cell migration, actin regulation, stem cell recruitment\n- GHK-Cu: Collagen synthesis, gene expression modulation, copper delivery, antioxidant upregulation\n\nStorage: Refrigerated (2–8°C). Do not freeze.\nDelivery: Free tracked UK delivery. You will receive a tracking email within 2-3 days of dispatch. R&D purposes only.`
  },
  {
    id: 'nad-overview', title: 'NAD+ Overview',
    tags: ['nad+', 'nad', 'nicotinamide adenine dinucleotide', 'nad plus', 'coenzyme', 'overview', 'what is', 'aging'],
    content: `NAD+ (Nicotinamide Adenine Dinucleotide) is a critical coenzyme found in every living cell. Exists in two forms: NAD+ (oxidized) and NADH (reduced). Essential for over 500 enzymatic reactions. Plays central roles in metabolism, DNA repair, gene expression, and cellular signaling. Discovered by Arthur Harden and William John Young in 1906. Molecular weight: 663.4 Da. NAD+ levels decline ~50% between ages 40 and 60 in certain tissues. Key research contributions from David Sinclair (Harvard), Charles Brenner (City of Hope), and Shin-ichiro Imai (Washington University).`
  },
  {
    id: 'nad-mechanism', title: 'NAD+ Mechanisms and Biological Roles',
    tags: ['nad+', 'nad', 'mechanism', 'how does it work', 'sirtuin', 'parp', 'cd38', 'metabolism', 'aging', 'dna repair'],
    content: `NAD+ biological pathways:\n\n1. Sirtuin Activation: Essential co-substrate for sirtuins (SIRT1-7) — protein deacetylases regulating aging, metabolism, stress resistance, DNA repair.\n2. DNA Repair (PARP): PARPs use NAD+ to facilitate DNA damage repair. Increased DNA damage with age depletes NAD+.\n3. Metabolic Functions: Essential electron carrier in glycolysis, TCA cycle, and oxidative phosphorylation.\n4. CD38 and Immune Regulation: CD38 is the primary driver of age-related NAD+ decline. Increases with age and chronic inflammation.\n5. Circadian Rhythm: NAD+ levels oscillate in circadian pattern, regulating the clock through SIRT1.\n6. Cellular Signaling: Precursor to cADPR and NAADP, critical calcium-mobilizing second messengers.`
  },
  {
    id: 'nad-research', title: 'NAD+ Published Research',
    tags: ['nad+', 'nad', 'research', 'study', 'aging', 'longevity', 'sirtuin', 'clinical trial', 'evidence'],
    content: `Key NAD+ research:\n\nAge-Related Decline:\n- Camacho-Pereira et al. (Cell Metabolism, 2016): Identified CD38 as primary enzyme for age-related NAD+ decline.\n- Massudi et al. (2012): Quantified age-dependent NAD+ decline in human skin.\n\nPreclinical Aging:\n- Zhang et al. (Science, 2016): NAD+ repletion improved mitochondrial function, reversed muscle deterioration, extended lifespan in mice.\n- Mills et al. (Cell Metabolism, 2016): Long-term NMN slowed age-related decline in mice.\n\nHuman Studies:\n- Martens et al. (2018): NR supplementation increased NAD+ levels in healthy adults.\n- Yi et al. (2023): NMN improved muscle insulin sensitivity in prediabetic women.\n\nNeuroscience:\n- Hou et al. (PNAS, 2018): NAD+ supplementation improved cognition, reduced neuroinflammation in AD mouse models.`
  },
  {
    id: 'nad-product', title: 'Alluvi NAD+ Product',
    tags: ['nad+', 'nad', 'product', 'buy', 'purchase', 'price', 'stock', 'alluvi', '1000mg', 'order', 'cost'],
    content: `Alluvi NAD+ 1,000mg (SKU: NAD-1000MG) — £140 GBP\n- 2× Pre-filled NAD+ pens (500mg each)\n- Total: 1,000mg NAD+\n- Includes research information sheet\n- Currently OUT OF STOCK\n\nStorage: Refrigerated (2–8°C). Do not freeze.\nDelivery: Free tracked UK delivery. You will receive a tracking email within 2-3 days of dispatch.\nFor in-vitro experiments and laboratory use only.`
  },
  {
    id: 'retatrutide-vs-tirzepatide', title: 'Retatrutide vs Tirzepatide Comparison',
    tags: ['retatrutide', 'tirzepatide', 'comparison', 'vs', 'versus', 'difference', 'compare', 'which is better', 'triple vs dual'],
    content: `Retatrutide vs Tirzepatide:\n\nReceptor Targets:\n- Tirzepatide: Dual agonist (GIP + GLP-1)\n- Retatrutide: Triple agonist (GIP + GLP-1 + Glucagon)\n\nKey Difference: Retatrutide's glucagon receptor activation adds increased energy expenditure, enhanced lipolysis, and potential hepatic fat reduction.\n\nClinical Data (Phase 2):\n- Tirzepatide (SURMOUNT-1, 72 wks): Up to -20.9% body weight at 15mg\n- Retatrutide (Phase 2, 48 wks): Up to -24.2% body weight at 12mg\n(Different trials — direct comparison limited)\n\nDevelopment Status:\n- Tirzepatide: FDA approved (Mounjaro/Zepbound)\n- Retatrutide: Phase 3 ongoing (TRIUMPH program)\n\nAlluvi: Retatrutide IN STOCK (20mg £100, 40mg £150). Tirzepatide OUT OF STOCK (40mg £100).`
  },
  {
    id: 'retatrutide-effects', title: 'Retatrutide Effects Observed in Research',
    tags: ['retatrutide', 'effects', 'side effects', 'weight loss', 'results', 'what happens', 'benefits', 'nausea', 'appetite'],
    content: `Effects observed in Retatrutide clinical trials:\n\nWeight/Metabolic Effects (from Phase 2 trials):\n- Significant dose-dependent weight reduction: up to 24.2% body weight loss at 12mg over 48 weeks\n- Reduced appetite and food intake reported by trial participants\n- Improved glycemic control: HbA1c reductions up to -2.02 percentage points\n- Reduced liver fat: up to 86% reduction in hepatic fat content measured by MRI\n- Improvements in cholesterol and triglyceride levels observed\n\nCommonly Reported Side Effects in Trials:\n- Gastrointestinal: nausea (most common, especially during dose escalation), diarrhea, vomiting, constipation\n- Decreased appetite (considered both an effect and side effect)\n- Mild injection site reactions\n- Most GI side effects were mild-to-moderate and tended to decrease over time\n- Side effects were more common at higher doses\n\nThe triple agonist mechanism (GIP + GLP-1 + Glucagon) is thought to produce greater effects than dual agonists through added energy expenditure from glucagon receptor activation.\n\nNote: These are findings from controlled clinical research trials. Individual experiences may vary.`
  },
  {
    id: 'tirzepatide-effects', title: 'Tirzepatide Effects Observed in Research',
    tags: ['tirzepatide', 'effects', 'side effects', 'weight loss', 'results', 'what happens', 'benefits', 'mounjaro', 'zepbound'],
    content: `Effects observed in Tirzepatide clinical trials:\n\nWeight/Metabolic Effects:\n- SURMOUNT-1 trial: weight reductions of -15.0% (5mg), -19.5% (10mg), -20.9% (15mg) over 72 weeks\n- 36.2% of participants on 15mg achieved ≥25% body weight reduction\n- SURPASS-2: Superior to semaglutide 1mg for both HbA1c and weight loss\n- Significant improvements in blood sugar control, insulin sensitivity, and lipid profiles\n- Reduced waist circumference\n- Improvements in blood pressure observed\n- Reduced markers of inflammation (C-reactive protein)\n\nCommonly Reported Side Effects in Trials:\n- Gastrointestinal: nausea (most frequent, typically during dose escalation), diarrhea, decreased appetite, vomiting, constipation, dyspepsia\n- Most GI effects were mild-to-moderate and transient\n- Injection site reactions (mild)\n- Lower rates of hypoglycemia compared to insulin-based treatments\n- Gradual dose escalation was used in trials to minimize GI side effects\n\nTirzepatide is FDA-approved as Mounjaro (type 2 diabetes) and Zepbound (obesity), making it one of the most studied peptides with extensive human clinical data.\n\nNote: These findings are from published clinical research. Individual responses may differ.`
  },
  {
    id: 'bpc157-effects', title: 'BPC-157 Effects Observed in Research',
    tags: ['bpc-157', 'bpc157', 'effects', 'side effects', 'what happens', 'benefits', 'healing', 'recovery', 'gut'],
    content: `Effects observed in BPC-157 research (primarily preclinical/animal studies):\n\nEffects Reported in Animal Studies:\n- Accelerated healing of tendons, ligaments, muscles, and bones in rat models\n- Gut protective effects: reduced gastric ulceration, improved intestinal healing in IBD models\n- Accelerated wound closure and increased collagen deposition\n- Reduced inflammation markers in various injury models\n- Neuroprotective effects observed in brain injury rat models\n- Protection against NSAID-induced gut damage in animal studies\n\nAnecdotal Reports from the Research Community:\n- Researchers and community members have reported observations of improved recovery from soft tissue injuries\n- Gut health improvements have been frequently discussed in research forums\n- Joint comfort improvements noted anecdotally\n- Generally well-tolerated in animal studies with no significant adverse effects reported at standard research doses\n\nImportant Limitations:\n- Most research is from animal (rat) models, primarily from one research group (Sikiric et al., University of Zagreb)\n- No completed large-scale human clinical trials\n- Independent replication of results is limited\n- Anecdotal reports should be interpreted cautiously\n\nNote: Human clinical data is limited. Published findings are primarily from preclinical research.`
  },
  {
    id: 'tb500-effects', title: 'TB-500 Effects Observed in Research',
    tags: ['tb-500', 'tb500', 'effects', 'side effects', 'what happens', 'benefits', 'healing', 'recovery', 'thymosin'],
    content: `Effects observed in TB-500 / Thymosin Beta-4 research:\n\nEffects from Published Studies:\n- Cardiac: Reduced infarct size and promoted cardiomyocyte survival after ischemic injury in mice (Bock-Marquette, Nature 2004)\n- Wound healing: Accelerated dermal wound closure, reduced scarring in animal models\n- Corneal healing: Promoted corneal repair, reduced inflammation — led to clinical trials for dry eye (RGN-259, Phase 2 completed with positive results)\n- Neurological: Improved functional recovery after brain injury and stroke in rat models\n- Hair growth: Stimulated hair follicle stem cells in mouse models\n- Anti-inflammatory: Reduced TNF-α and IL-1β in experimental models\n- Reduced fibrosis/scar tissue formation in animal models\n\nAnecdotal Reports from Research Community:\n- Improved recovery from muscle and soft tissue injuries\n- Enhanced flexibility and reduced stiffness reported\n- Hair growth improvements noted by some community members\n- Generally considered well-tolerated based on animal safety profiles\n\nClinical Status:\n- Most advanced in corneal healing (RGN-259 eye drops reached Phase 2/3 trials)\n- Tβ4 has over 1,000 published studies, giving it one of the strongest preclinical evidence bases of any research peptide\n\nNote: Most evidence is preclinical. Clinical trials are ongoing for specific applications.`
  },
  {
    id: 'ghkcu-effects', title: 'GHK-Cu Effects Observed in Research',
    tags: ['ghk-cu', 'ghk cu', 'copper peptide', 'effects', 'skin', 'anti-aging', 'collagen', 'what happens', 'benefits', 'glow'],
    content: `Effects observed in GHK-Cu research (includes human studies):\n\nHuman Clinical Study Results:\n- Leyden et al. (2002): GHK-Cu cream improved skin density, thickness, and firmness while reducing fine lines and wrinkles in human participants\n- Finkley et al. (2005): After 12 weeks of GHK-Cu facial cream use, participants showed improved skin laxity, clarity, reduced fine lines, and overall appearance improvement\n- Improved skin texture and tone observed across multiple human cosmetic studies\n\nEffects from Laboratory/Animal Research:\n- Stimulated collagen types I, III, and V production\n- Upregulated over 4,000 genes including those involved in tissue repair and antioxidant defense (Broad Institute study)\n- Promoted wound healing and angiogenesis\n- Increased superoxide dismutase (SOD) — the body's primary antioxidant enzyme\n- Stimulated hair growth by promoting dermal papilla cell proliferation in mice\n- Anti-inflammatory effects: suppressed TNF-α, IL-6\n\nIn the Alluvi Glow Product:\n- Combined with BPC-157 and TB-500 for complementary tissue repair and skin health mechanisms\n- GHK-Cu provides the collagen/skin matrix support while BPC-157 and TB-500 contribute anti-inflammatory and cell migration properties\n\nNote: GHK-Cu has some of the strongest human clinical evidence among research peptides, particularly for skin applications.`
  },
  {
    id: 'nad-effects', title: 'NAD+ Effects Observed in Research',
    tags: ['nad+', 'nad', 'effects', 'aging', 'energy', 'anti-aging', 'what happens', 'benefits', 'longevity'],
    content: `Effects observed in NAD+ research:\n\nHuman Study Results:\n- Martens et al. (2018): NR (NAD+ precursor) supplementation successfully increased NAD+ levels in healthy middle-aged and older adults\n- Yi et al. (2023): NMN supplementation improved muscle insulin sensitivity in prediabetic women\n- Multiple human studies confirmed that NAD+ precursors (NR, NMN) effectively boost NAD+ levels in blood and tissues\n\nEffects from Animal Research:\n- Improved mitochondrial function and reversed age-related muscle deterioration (Zhang et al., Science 2016)\n- Extended lifespan and slowed physiological aging markers in mice (Mills et al., Cell Metabolism 2016)\n- Improved cognitive function and reduced neuroinflammation in Alzheimer's disease mouse models (Hou et al., PNAS 2018)\n- Enhanced DNA repair capacity through PARP activation\n- Improved metabolic function and insulin sensitivity\n\nAnecdotal Reports from Research Community:\n- Increased energy levels and reduced fatigue commonly reported\n- Improved mental clarity and cognitive function noted\n- Better exercise recovery and physical performance discussed\n- Improved sleep quality mentioned by some community members\n\nKey Context:\n- NAD+ levels naturally decline ~50% between ages 40-60\n- CD38 enzyme (increases with age) is the primary driver of NAD+ decline\n- Replenishing NAD+ is a major focus of longevity research\n\nNote: NAD+ supplementation is an active area of clinical research with growing human evidence.`
  },
  {
    id: 'anti-counterfeit', title: 'Alluvi Anti-Counterfeit & Product Authenticity Guide',
    tags: ['seal', 'fake', 'counterfeit', 'verify', 'authentic', 'genuine', 'real', 'number', 'spot a fake', 'verification', 'original', 'legitimate', 'scam', 'hologram', 'uv', 'needle', 'pen lid', 'tamper', 'shrink wrap', 'security'],
    content: `Alluvi Anti-Counterfeit System:\n\nThere are many counterfeit peptide products circulating in the market. Only products purchased directly from Alluvi usa are guaranteed to be genuine and original Alluvi products.\n\nSeal Number Verification:\n- Every genuine Alluvi product has a unique seal number on the packaging (the Alluvi Authenticity Seal)\n- Customers can verify authenticity by providing the seal number to the Alluvi AI assistant, which checks it against the official database in real-time\n- Customers can also visit alluvi.org/spot-a-fake to verify their product\n- If the seal number is in the database: the product is genuine\n- If the seal number is NOT found: the product may be counterfeit\n\nHow to Identify a Genuine Alluvi Product — All Authenticity Features:\n\n1. Alluvi Authenticity Mark: Every genuine product carries the official Alluvi authenticity mark on the packaging.\n\n2. Alluvi Authenticity Seal: A unique numbered seal on each product. This number can be verified against Alluvi's database.\n\n3. Tamper-Proof Security Seal: Alluvi no longer uses shrink wrap. Instead, all products now feature a tamper-proof security seal. If the seal is broken or missing, the product may have been tampered with.\n\n4. Front Hologram: All genuine Alluvi products include a hologram on the front of the packaging. This hologram is difficult to replicate and is a key authenticity indicator.\n\n5. UV Hidden Mark: Using a UV torch on a genuine Alluvi product will reveal a hidden mark that is invisible to the naked eye. This is one of the newest authenticity features. If the UV mark is absent, the product is likely counterfeit.\n\n6. Branded Pen Lids: Since March 2025, all Alluvi pens have "ALLUVI" written on the pen lids. If the pen lid is blank or has a different brand name, the product is not genuine.\n\n7. Branded Needles: All needles included inside genuine Alluvi product boxes have "ALLUVI" printed on them. Generic or unbranded needles indicate a counterfeit product.\n\n8. Research Information Sheet: Every genuine product includes an Alluvi research information sheet.\n\n9. Janoshik Lab Testing: All genuine Alluvi products are third-party lab tested by Janoshik with publicly available test results.\n\nQuick Checklist — Is Your Product Real?\n- ✓ Alluvi authenticity mark present\n- ✓ Unique numbered authenticity seal (verifiable in this chat or at alluvi.org/spot-a-fake)\n- ✓ Tamper-proof security seal intact (NOT shrink wrap)\n- ✓ Front hologram present\n- ✓ UV torch reveals hidden mark\n- ✓ "ALLUVI" printed on pen lids\n- ✓ "ALLUVI" printed on needles\n- ✓ Research information sheet included\n\nIf ANY of these features are missing, the product may be counterfeit. Only purchase from Alluvi usa.\n\nIf you suspect you have a counterfeit product, do not use it for any research. Contact Alluvi support via Live Chat at alluvi.org/track-order.`
  },
  {
    id: 'peptide-basics', title: 'What Are Peptides — General Information',
    tags: ['peptide', 'what is a peptide', 'amino acid', 'basics', 'general', 'definition', 'protein'],
    content: `Peptides are short chains of amino acids linked by peptide bonds. Generally 2–50 amino acids (longer = protein). Connected by amide bonds via condensation reactions. The human body produces hundreds of peptide hormones, neuropeptides, and antimicrobial peptides (e.g. insulin: 51 aa, oxytocin: 9 aa). Modern solid-phase peptide synthesis (SPPS), developed by Bruce Merrifield (Nobel Prize, 1984), enables lab production with high purity. Widely used in pharmacological research, drug development, biochemistry, and molecular biology.`
  },
  {
    id: 'peptide-storage', title: 'Peptide Storage and Handling for Research',
    tags: ['storage', 'handling', 'temperature', 'stability', 'refrigerate', 'freeze', 'degradation', 'shelf life', 'how to store'],
    content: `Peptide storage for research:\n\nTemperature: Most peptides at 2–8°C for short/medium-term. -20°C/-80°C for long-term lyophilized storage. Pre-filled pens at 2–8°C per manufacturer spec. Avoid repeated freeze-thaw cycles.\n\nLight/Moisture: Protect from light (especially tryptophan, methionine, cysteine-containing peptides). Keep lyophilized peptides desiccated. Seal containers tightly.\n\nReconstitution: Use sterile nuclease-free water or appropriate buffer. Solutions less stable than lyophilized form. Aliquot into single-use volumes.\n\nAlluvi Products: All stored at 2–8°C (refrigerated). Do not freeze. Sealed format for compound stability.`
  },
  {
    id: 'peptide-quality', title: 'Peptide Quality and Purity Testing',
    tags: ['quality', 'purity', 'testing', 'hplc', 'mass spec', 'janoshik', 'lab test', 'certificate', 'analysis', 'authentic'],
    content: `Peptide quality testing:\n\nHPLC: Gold standard for purity. Research-grade requires ≥95%. Detects deletion sequences, truncated peptides.\nMass Spectrometry: Confirms molecular identity. LC-MS, ESI-MS, MALDI-TOF commonly used.\nAmino Acid Analysis: Verifies correct composition.\n\nThird-Party Testing: Alluvi products are lab tested by Janoshik — an independent analytical lab specializing in compound verification. Public test results available on their website.\n\nAlluvi's Commitment: All products undergo Janoshik third-party lab testing for identity and purity verification. Lab test certificates available on Alluvi usa.`
  },
  {
    id: 'research-disclaimer', title: 'Research Use Disclaimer',
    tags: ['disclaimer', 'research', 'r&d', 'not for human use', 'in vitro', 'legal', 'compliance'],
    content: `IMPORTANT: All Alluvi peptide products are for in-vitro research and R&D purposes ONLY. NOT for: clinical trials involving humans, administration to humans, supply to others for human use, diagnostic/therapeutic purposes, food or cosmetics.\n\nPurchasers must ensure compliance with all applicable regulations regarding purchase, storage, handling, and use of research peptides.`
  },
  {
    id: 'alluvi-company', title: 'About Alluvi',
    tags: ['alluvi', 'company', 'about', 'who', 'supplier', 'uk', 'peptide supplier', 'store', 'website'],
    content: `Alluvi is a UK-based research peptide supplier. Website: alluvi.org\n\nFeatures:\n- Third-party lab testing by Janoshik for all products\n- Pre-filled research pen format for convenience and dosing accuracy\n- Free tracked UK delivery on all orders\n- Products supplied in sealed format\n- Research information sheets included with each product\n\nProduct Range:\n- Retatrutide 20mg (£100) — Triple GIP/GLP-1/GCG receptor agonist — IN STOCK\n- Retatrutide 40mg (£150) — Triple GIP/GLP-1/GCG receptor agonist — IN STOCK\n- Bundle: 2× Retatrutide 20mg (£190, save £10) — IN STOCK\n- Bundle: 2× Retatrutide 40mg (£330) — IN STOCK\n- Tirzepatide 40mg (£100) — Dual GIP/GLP-1 receptor agonist — OUT OF STOCK\n- BPC-157 & TB-500 40mg (£130) — 20mg BPC-157 + 20mg TB-500 tissue repair peptides — IN STOCK\n- Glow 70mg (£100) — 10mg BPC-157 + 10mg TB-500 + 50mg GHK-Cu (2 pens) — IN STOCK\n- NAD+ 1,000mg (£140) — 2× 500mg pens, cellular metabolism coenzyme — OUT OF STOCK\n\nAll products are for R&D purposes only.\n\nPayment: Bank transfer only (no credit/debit cards accepted). After placing an order and reserving a slot, customers receive a payment reminder email with a "Complete Payment" button. This opens a payment page showing the banking details. Once the bank transfer is completed, customers upload a screenshot of the transfer. Alluvi's payment team then verifies the payment and confirms the order.\n\nShipping: Free tracked UK delivery on all orders. Within 2-3 days of dispatch, customers receive an email with tracking information for their package.\n\nOrder Tracking: Customers can visit alluvi.org/track-order to view their order details and delivery status. A Live Chat option is available on the track-order page where an Alluvi expert can connect and assist with any questions.\n\nSupport: Live Chat on the track-order page at alluvi.org/track-order.`
  },
  {
    id: 'ordering-delivery', title: 'Ordering and Delivery Information',
    tags: ['order', 'delivery', 'shipping', 'tracking', 'uk', 'how to order', 'dispatch', 'buy', 'payment', 'bank transfer', 'screenshot', 'checkout', 'reserve', 'slot'],
    content: `How to Order from Alluvi:\n\n1. Browse Products: Visit alluvi.org/shop and browse the available research peptides.\n2. Add to Cart: Select your products and add them to your cart.\n3. Reserve a Slot: Proceed to checkout and reserve your order slot.\n4. Payment Reminder Email: You will receive an email with a payment reminder. This email contains a "Complete Payment" button.\n5. Complete Payment: Click the "Complete Payment" button to open the payment page. The page displays Alluvi's banking details for bank transfer. Complete the bank transfer using the details provided.\n6. Upload Screenshot: After completing your bank transfer, upload a screenshot of the transaction on the payment page as proof of payment.\n7. Verification: Alluvi's payment team will verify your payment and confirm your order. You will be notified of the payment status.\n\nPayment Method: Bank transfer ONLY. Alluvi does not currently accept credit cards or debit cards.\n\nDelivery:\n- Free tracked UK delivery on all orders\n- Discreet packaging with products supplied in sealed format\n- Within 2-3 days of dispatch, you will receive an email with tracking information for your package\n\nOrder Tracking:\n- Visit alluvi.org/track-order to view your order details and delivery status\n- The track-order page includes a Live Chat option where you can connect with an Alluvi expert for real-time assistance with your order\n\nSupport: Use the Live Chat on the track-order page at alluvi.org/track-order to get help from an Alluvi expert.`
  },
  {
    id: 'research-methodology', title: 'Peptide Research Methodology',
    tags: ['research', 'methodology', 'in vitro', 'assay', 'cell culture', 'experiment', 'protocol', 'laboratory'],
    content: `Common peptide research methodologies:\n\nCell-Based Assays: Proliferation (MTT, WST-1, BrdU), migration (scratch/wound, transwell/Boyden), receptor binding (radioligand, fluorescence polarization), reporter gene assays.\n\nMolecular Biology: Western blot (protein expression), qRT-PCR (gene expression), ELISA (secreted proteins), immunohistochemistry/immunofluorescence.\n\nStability/Formulation: HPLC stability testing, accelerated stability studies, dissolution testing.\n\nBest Practices: Vehicle-only controls, positive controls, dose-response experiments, biological replicates (n≥3), proper storage (2-8°C), fresh working solutions.`
  },
]

// ── RAG Retrieval Engine (TF-IDF + tag boosting) ────────────────────────

const RAG_STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'need', 'to', 'of', 'in', 'for', 'on',
  'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'out', 'off', 'over', 'under', 'again', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all',
  'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or', 'if', 'while', 'about', 'up', 'that',
  'this', 'these', 'those', 'what', 'which', 'who', 'whom', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you',
  'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their', 'tell', 'about', 'please', 'know',
])

function ragTokenize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9+\-]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 2 && !RAG_STOP_WORDS.has(t))
}

// Pre-compute per-document term frequencies & inverse document frequencies
const ragDocTFs = RAG_DOCUMENTS.map(doc => {
  const tokens = ragTokenize(doc.content + ' ' + doc.tags.join(' ') + ' ' + doc.title)
  const tf = new Map()
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1)
  return tf
})

const ragDocFreq = new Map()
for (const tf of ragDocTFs) {
  for (const term of tf.keys()) ragDocFreq.set(term, (ragDocFreq.get(term) || 0) + 1)
}

const ragDocCount = RAG_DOCUMENTS.length
function ragIdf(term) {
  const df = ragDocFreq.get(term) || 0
  return df === 0 ? 0 : Math.log((ragDocCount + 1) / (df + 1)) + 1
}

function ragRetrieve(query, topK = 5) {
  const qTokens = ragTokenize(query)
  if (!qTokens.length) {
    return RAG_DOCUMENTS.filter(d => d.id === 'alluvi-company' || d.id === 'peptide-basics')
  }
  const qLower = String(query || '').toLowerCase().trim()

  const scored = RAG_DOCUMENTS.map((doc, idx) => {
    const tf = ragDocTFs[idx]
    let score = 0
    // TF-IDF
    for (const qt of qTokens) { const t = tf.get(qt) || 0; if (t) score += t * ragIdf(qt) }
    // Tag boost (3x)
    const tagsJoined = doc.tags.join(' ')
    for (const qt of qTokens) { if (tagsJoined.includes(qt)) score += 3 * ragIdf(qt) }
    // Title boost (2x)
    const titleLower = doc.title.toLowerCase()
    for (const qt of qTokens) { if (titleLower.includes(qt)) score += 2 * ragIdf(qt) }
    // Exact phrase match
    if (qLower.length > 3 && doc.content.toLowerCase().includes(qLower)) score += 5
    for (const tag of doc.tags) { if (tag === qLower || qLower.includes(tag)) score += 5 }
    return { id: doc.id, title: doc.title, content: doc.content, score }
  })

  scored.sort((a, b) => b.score - a.score)
  const relevant = scored.filter(d => d.score > 0).slice(0, topK)
  if (!relevant.length) {
    return RAG_DOCUMENTS.filter(d => d.id === 'alluvi-company' || d.id === 'peptide-basics')
  }
  return relevant
}

// ── System prompt (RAG-grounded) ────────────────────────────────────────

const ALLUVI_SYSTEM_PROMPT = `You are the Alluvi Peptide Research Assistant — a knowledgeable AI specialist helping people understand peptide science. You work for Alluvi, a UK-based research peptide supplier at Alluvi usa.

HOW TO RESPOND:
1. FREELY discuss published research findings, clinical trial results, mechanisms of action, and observed effects — including effects observed in human clinical trials. This is factual scientific information from published literature.
2. Frame everything as research findings, not personal advice. Use language like "research has shown...", "in clinical trials, participants experienced...", "studies indicate...", "published data suggests...".
3. NEVER give personal medical advice, recommend specific dosages for individuals, or tell someone to take/inject a peptide. If asked "should I take X?" or "what dose should I use?", say you cannot provide personal medical guidance and suggest consulting a healthcare professional.
4. DO answer questions like "what are the effects of retatrutide?", "what happens when people use BPC-157?", "what did clinical trials show?" — these are asking about published research, not personal advice. Answer them thoroughly.
5. Ground your answers in the CONTEXT DOCUMENTS provided. Reference studies with author names, year, and journal when available. If context is insufficient, say so honestly.
6. Be scientifically accurate and precise. Use proper terminology.
7. Use ONLY product/pricing/stock info from context documents — these reflect the current Alluvi catalog.
8. Keep responses concise but thorough. Use bullet points and clear formatting.
9. You may compare peptides but note limitations of cross-study comparisons.
10. ONLY answer peptide/research/Alluvi related questions. Politely redirect unrelated questions.
11. End responses with a brief note: "Note: Alluvi products are supplied for research purposes. Always consult a qualified professional for personal health decisions."

Alluvi Info:
- Website: alluvi.org
- Shipping: Free tracked UK delivery on all orders. Within 2-3 days of dispatch, customers receive an email with tracking information for their package.
- Payment: Bank transfer ONLY (no credit/debit cards). After reserving a slot, customers receive a payment reminder email with a "Complete Payment" button that opens a payment page with banking details. After completing the transfer, customers upload a screenshot of the bank transfer. Alluvi's payment team verifies and confirms.
- Order tracking: alluvi.org/track-order — customers can view order details and use the Live Chat option to connect with an Alluvi expert for assistance.
- Support: Live Chat available on the track-order page at alluvi.org/track-order.

SEAL NUMBER VERIFICATION (Anti-Counterfeit):
- Every genuine Alluvi product has a unique seal number on the packaging.
- There are many counterfeit peptide products on the market. ONLY products purchased from Alluvi usa are guaranteed genuine and original.
- When a user provides a seal number to verify, the system will automatically check it against Alluvi's database and inject the result into your context as a SEAL_VERIFICATION_RESULT.
- If the result says VALID: Tell the user their seal number is verified and the product is a genuine Alluvi product. Reassure them.
- If the result says INVALID: Tell the user this seal number was NOT found in Alluvi's database. The product may be counterfeit. Advise them to only purchase from Alluvi usa to ensure authenticity.
- If a user asks you to list, share, or reveal seal numbers, REFUSE. Say you cannot share the seal database for security reasons but you can verify any specific number they provide.
- NEVER output seal numbers, never list them, never hint at patterns in them. Only confirm valid/invalid for a specific number the user provides.
- Users can also verify products at alluvi.org/spot-a-fake.`

// ── Gemini API call ─────────────────────────────────────────────────────

async function callGemini(messages, contextDocs) {
  const contextBlock = contextDocs.map(d => `--- ${d.title} ---\n${d.content}`).join('\n\n')
  const systemWithContext = `${ALLUVI_SYSTEM_PROMPT}\n\n=== CONTEXT DOCUMENTS (RAG-retrieved — base your answer on these) ===\n\n${contextBlock}\n\n=== END CONTEXT ===`

  // Gemini uses a different format: system instruction + contents array
  const geminiUrl = `https://generativelanguage.googleapis.com/${GEMINI_API_VER}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`

  const contents = []
  for (const m of messages) {
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })
  }

  const geminiRes = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemWithContext }] },
      contents,
      generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
    }),
  })

  const geminiData = await geminiRes.json().catch(() => ({}))

  if (!geminiRes.ok) {
    console.error('[ai-chat] Gemini error:', { status: geminiRes.status, error: geminiData?.error?.message || JSON.stringify(geminiData).slice(0, 200) })
    throw new Error(`Gemini API returned ${geminiRes.status}`)
  }

  const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || ''
  if (!text) throw new Error('Empty Gemini response')
  return text
}

// ── HuggingFace API call (fallback) ─────────────────────────────────────

async function callHuggingFace(messages, contextDocs) {
  const contextBlock = contextDocs.map(d => `--- ${d.title} ---\n${d.content}`).join('\n\n')
  const systemWithContext = `${ALLUVI_SYSTEM_PROMPT}\n\n=== CONTEXT DOCUMENTS ===\n\n${contextBlock}\n\n=== END CONTEXT ===`

  const hfMessages = [
    { role: 'system', content: systemWithContext },
    ...messages,
  ]

  const hfRes = await fetch('https://router.huggingface.co/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${HF_API_KEY}` },
    body: JSON.stringify({ model: HF_MODEL, messages: hfMessages, max_tokens: 1024, temperature: 0.7 }),
  })

  const hfData = await hfRes.json().catch(() => ({}))
  if (!hfRes.ok) {
    console.error('[ai-chat] HuggingFace error:', { status: hfRes.status, error: hfData?.error })
    throw new Error(`HuggingFace API returned ${hfRes.status}`)
  }
  return hfData?.choices?.[0]?.message?.content || ''
}

// ── Simple rate limiter ─────────────────────────────────────────────────

const aiRateMap = new Map()
function aiRateCheck(ip) {
  const now = Date.now()
  const entry = aiRateMap.get(ip)
  if (!entry || now - entry.t > 60000) { aiRateMap.set(ip, { t: now, c: 1 }); return true }
  entry.c++
  return entry.c <= 15
}
setInterval(() => { const now = Date.now(); for (const [k, v] of aiRateMap) { if (now - v.t > 120000) aiRateMap.delete(k) } }, 300000)

// ── Chat endpoint ───────────────────────────────────────────────────────

app.post('/api/ai-chat', async (req, res) => {
  if (!GEMINI_API_KEY && !HF_API_KEY) {
    return res.status(503).json({ error: 'AI chat is not configured' })
  }

  const ip = req.ip || req.connection?.remoteAddress || 'unknown'
  if (!aiRateCheck(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' })
  }

  try {
    const userMessage = String(req.body?.message || '').trim()
    if (!userMessage) return res.status(400).json({ error: 'Message is required' })
    if (userMessage.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 chars)' })

    // Conversation history
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-6) : []
    const messages = []
    for (const msg of history) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: String(msg.text || msg.content || '').slice(0, 2000) })
      }
    }
    messages.push({ role: 'user', content: userMessage })

    // Seal number verification — check before sending to LLM
    const sealResults = checkSealNumbers(userMessage)
    let sealContext = ''
    if (sealResults && sealResults.length > 0) {
      const parts = sealResults.map(r =>
        r.valid
          ? `SEAL_VERIFICATION_RESULT: Seal number ${r.number} is VALID — this is a genuine Alluvi product.`
          : `SEAL_VERIFICATION_RESULT: Seal number ${r.number} is INVALID — this number was NOT found in Alluvi's database. This product may be counterfeit.`
      )
      sealContext = '\n\n' + parts.join('\n')
      console.log(`[ai-chat] Seal check: ${sealResults.map(r => r.number + '=' + (r.valid ? 'VALID' : 'INVALID')).join(', ')}`)
    }

    // Append seal verification result to the user message so the LLM sees it
    if (sealContext) {
      messages[messages.length - 1] = {
        role: 'user',
        content: userMessage + sealContext,
      }
    }

    // RAG retrieval
    const contextDocs = ragRetrieve(userMessage, 5)
    console.log(`[ai-chat] RAG retrieved ${contextDocs.length} docs for: "${userMessage.slice(0, 80)}"`)

    let reply = ''
    let provider = ''

    // Try Gemini first, fall back to HuggingFace
    if (GEMINI_API_KEY) {
      try {
        reply = await callGemini(messages, contextDocs)
        provider = 'gemini'
      } catch (gemErr) {
        console.error('[ai-chat] Gemini failed, trying HuggingFace fallback:', gemErr?.message)
      }
    }

    if (!reply && HF_API_KEY) {
      try {
        reply = await callHuggingFace(messages, contextDocs)
        provider = 'huggingface'
      } catch (hfErr) {
        console.error('[ai-chat] HuggingFace also failed:', hfErr?.message)
      }
    }

    if (!reply) {
      return res.status(502).json({ error: 'AI service temporarily unavailable. Please try again.' })
    }

    console.log(`[ai-chat] Reply via ${provider}, length: ${reply.length}`)

    return res.json({
      reply,
      sources: contextDocs.map(d => ({ id: d.id, title: d.title })),
      provider,
    })
  } catch (e) {
    console.error('[ai-chat] Error:', e?.message || String(e))
    return res.status(500).json({ error: 'Failed to process chat message' })
  }
})

// ── Suggested questions ─────────────────────────────────────────────────

app.get('/api/ai-chat/suggestions', (_req, res) => {
  res.json({
    suggestions: [
      'What is Retatrutide and how does it work?',
      'Compare Retatrutide vs Tirzepatide',
      'What research exists on BPC-157?',
      'Tell me about the Glow product',
      'How should peptides be stored for research?',
      'What products does Alluvi have in stock?',
    ],
  })
})

// ─── Newsletter subscribe (public) ──────────────────────────────────────────

const NEWSLETTER_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const NEWSLETTER_RATE_LIMIT_MAX = 5
const newsletterRateMap = new Map()

function newsletterRateLimit(ip) {
  const now = Date.now()
  const arr = (newsletterRateMap.get(ip) || []).filter((t) => now - t < NEWSLETTER_RATE_LIMIT_WINDOW_MS)
  if (arr.length >= NEWSLETTER_RATE_LIMIT_MAX) {
    newsletterRateMap.set(ip, arr)
    return false
  }
  arr.push(now)
  newsletterRateMap.set(ip, arr)
  return true
}

function escapeNewsletterHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

let newsletterAdminTransporter = null
function getNewsletterAdminTransporter() {
  if (newsletterAdminTransporter) return newsletterAdminTransporter
  const user = env('EMAIL_USER')
  const pass = env('EMAIL_PASS')
  if (!user || !pass) return null
  newsletterAdminTransporter = nodemailer.createTransport({
    host: env('SMTP_HOST', 'smtp.gmail.com'),
    port: Number(env('SMTP_PORT', '587')) || 587,
    secure: false,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  })
  return newsletterAdminTransporter
}

async function sendNewsletterAdminNotification({ email, source, ipAddress, userAgent, originLabel }) {
  const transporter = getNewsletterAdminTransporter()
  if (!transporter) return { success: false, error: 'smtp-not-configured' }

  const to = env('NEWSLETTER_NOTIFY_EMAIL', 'research@alluvi.org')
  const fromName = env('EMAIL_FROM_NAME', 'Alluvi')
  const fromEmail = env('EMAIL_FROM_EMAIL', env('EMAIL_USER', 'info@alluvi.org'))
  const subject = `New giveaway entry — ${email}`
  const submittedAt = new Date().toISOString()

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#0a0a0a;color:#fff;border-radius:12px">
      <h2 style="margin:0 0 16px;color:#FF8200">New Giveaway Entry</h2>
      ${originLabel ? `<p style="color:#aaa;margin:0 0 16px">Source site: <strong>${escapeNewsletterHtml(originLabel)}</strong></p>` : ''}
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:8px 0;color:#aaa;width:35%">Email</td><td style="padding:8px 0"><a href="mailto:${escapeNewsletterHtml(email)}" style="color:#FF8200">${escapeNewsletterHtml(email)}</a></td></tr>
        <tr><td style="padding:8px 0;color:#aaa">Source tag</td><td style="padding:8px 0">${escapeNewsletterHtml(source)}</td></tr>
        <tr><td style="padding:8px 0;color:#aaa">IP</td><td style="padding:8px 0">${escapeNewsletterHtml(ipAddress || '—')}</td></tr>
        <tr><td style="padding:8px 0;color:#aaa">User-Agent</td><td style="padding:8px 0;font-size:12px;color:#bbb">${escapeNewsletterHtml(userAgent || '—')}</td></tr>
        <tr><td style="padding:8px 0;color:#aaa">Submitted</td><td style="padding:8px 0">${escapeNewsletterHtml(submittedAt)}</td></tr>
      </table>
    </div>
  `

  const text = [
    `New Giveaway Entry${originLabel ? ` — ${originLabel}` : ''}`,
    `Email: ${email}`,
    `Source tag: ${source}`,
    `IP: ${ipAddress || '—'}`,
    `User-Agent: ${userAgent || '—'}`,
    `Submitted: ${submittedAt}`,
  ].join('\n')

  try {
    const info = await transporter.sendMail({
      from: `${fromName} <${fromEmail}>`,
      to,
      replyTo: email,
      subject,
      text,
      html,
    })
    return { success: true, messageId: info?.messageId }
  } catch (e) {
    return { success: false, error: e?.message || String(e) }
  }
}

async function ensureNewsletterTable() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS newsletter_subscribers (
        id INT NOT NULL AUTO_INCREMENT,
        email VARCHAR(255) NOT NULL,
        consent TINYINT(1) NOT NULL DEFAULT 0,
        source VARCHAR(64) NOT NULL DEFAULT 'home_popup_reta',
        ip_address VARCHAR(45),
        user_agent VARCHAR(512),
        is_winner TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_newsletter_email_source (email, source),
        INDEX idx_newsletter_created (created_at),
        INDEX idx_newsletter_winner (is_winner)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure newsletter_subscribers table:', msg)
    }
  }
}

app.post('/api/newsletter/subscribe', async (req, res) => {
  try {
    const body = req.body || {}
    const honeypot = String(body.website || '').trim()
    if (honeypot) {
      // silently 200 — don't tip off bots
      return res.status(200).json({ ok: true })
    }

    const email = String(body.email || '').trim().toLowerCase()
    const consent = body.consent === true || body.consent === 'true' || body.consent === 1 || body.consent === '1'
    const source = String(body.source || 'home_popup_reta').slice(0, 64) || 'home_popup_reta'

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' })
    }
    if (!consent) {
      return res.status(400).json({ error: 'Consent is required to enter the giveaway.' })
    }

    const ip =
      req.headers['cf-connecting-ip'] ||
      req.headers['true-client-ip'] ||
      req.headers['x-real-ip'] ||
      String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      ''
    const ipStr = String(ip).slice(0, 45)
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 512)

    if (ipStr && !newsletterRateLimit(ipStr)) {
      return res.status(429).json({ error: 'Too many submissions. Please try again later.' })
    }

    await ensureNewsletterTable()

    try {
      const [result] = await pool.execute(
        `INSERT INTO newsletter_subscribers
           (email, consent, source, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?)`,
        [email, consent ? 1 : 0, source, ipStr || null, userAgent || null]
      )

        // Fire-and-forget entry confirmation email — never block the response on email
        ; (async () => {
          try {
            await sendNewsletterEntryEmail(email, { productName: 'Retatrutide 40mg pen' })
          } catch (mailErr) {
            console.error('[newsletter] entry email failed:', mailErr?.message || mailErr)
          }
        })()

        // Fire-and-forget admin notification to research@alluvi.org
        ; (async () => {
          try {
            const originHeader = String(req.get('origin') || req.get('referer') || '').trim()
            let originLabel = ''
            if (originHeader) {
              try { originLabel = new URL(originHeader).hostname }
              catch { originLabel = originHeader.slice(0, 80) }
            }
            const adminRes = await sendNewsletterAdminNotification({
              email,
              source,
              ipAddress: ipStr,
              userAgent,
              originLabel,
            })
            if (!adminRes?.success) {
              console.warn('[newsletter] admin notification skipped/failed:', adminRes?.error)
            } else {
              console.log('[newsletter] admin notification sent:', adminRes.messageId)
            }
          } catch (mailErr) {
            console.error('[newsletter] admin notification failed:', mailErr?.message || mailErr)
          }
        })()

      return res.status(200).json({ ok: true, id: result?.insertId })
    } catch (insertErr) {
      const msg = String(insertErr?.message || '').toLowerCase()
      if (insertErr?.code === 'ER_DUP_ENTRY' || msg.includes('duplicate')) {
        return res.status(200).json({ ok: true, already_subscribed: true })
      }
      throw insertErr
    }
  } catch (e) {
    console.error('POST /api/newsletter/subscribe failed:', e?.message || e)
    return res.status(500).json({ error: 'Failed to submit. Please try again.' })
  }
})

// Start the server immediately, run schema checks in background
app.listen(PORT, () => {
  console.log(`✅ User order creation service running on port ${PORT}`)
})

  // Run schema checks in background (don't block server startup)
  ; (async () => {
    try {
      await ensurePaymentCaptureTable()
      await ensurePaymentCaptureEmailTrackingColumns()
      await ensurePaymentSessionsEmailTrackingColumns()
      await ensureOrdersPaymentRejectionReasonColumn()
      await ensurePasswordResetTokensTable()
      await ensureCustomerBlacklistTable()
      await ensureCustomerCreditsSchema()
      await ensureUsersAuthColumns()
      await ensureAffiliateSchema()
      await ensureNewsletterTable()
      console.log('✅ Database schema checks completed')
    } catch (e) {
      console.error('Schema checks failed:', e?.message || String(e))
      // Don't exit - server is already running
    }
  })()

