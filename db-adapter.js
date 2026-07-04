// =============================================================================
// db-adapter.js — drop-in `mysql2/promise`-compatible adapter backed by `pg`.
//
// Purpose: let the (originally MySQL) centralordermanagement service talk to a
// PostgreSQL / Supabase database WITHOUT rewriting the ~10k lines of query code.
// It exposes the small slice of the mysql2/promise API this service actually
// uses (createPool -> pool.execute/query/getConnection, connection
// .execute/query/beginTransaction/commit/rollback/release) and transparently
// translates MySQL SQL dialect to PostgreSQL on every call.
//
// Translations performed:
//   * `?` positional placeholders            -> `$1, $2, ...`
//   * backtick identifiers                    -> double quotes
//   * INSERT IGNORE INTO ...                  -> INSERT INTO ... ON CONFLICT DO NOTHING
//   * ON DUPLICATE KEY UPDATE ...             -> ON CONFLICT (<key>) DO UPDATE SET ...
//     (with VALUES(col) -> EXCLUDED.col, using the per-table key map below)
//   * DATE_ADD(x, INTERVAL n unit)            -> (x + INTERVAL 'n unit')
//   * IF(a, b, c)                             -> CASE WHEN a THEN b ELSE c END
//   * MySQL DDL (CREATE TABLE / ALTER TABLE)  -> Postgres DDL
//       AUTO_INCREMENT -> SERIAL/BIGSERIAL, DATETIME -> TIMESTAMPTZ,
//       TINYINT -> SMALLINT, JSON -> JSONB, ON UPDATE CURRENT_TIMESTAMP dropped,
//       UNIQUE KEY/INDEX/KEY clauses + ENGINE/CHARSET options handled
//   * INSERT statements get `RETURNING *` appended so `result.insertId` works
//
// Return shape mirrors mysql2: `await pool.execute(sql, params)` resolves to
// `[rowsOrOkPacket, fields]`. SELECT -> rows array; INSERT/UPDATE/DELETE ->
// an OkPacket-like object { insertId, affectedRows, changedRows, rows }.
//
// Value parsing is tuned to match mysql2: booleans come back as 1/0 and BIGINT
// as a JS number (not string), so existing comparisons keep working.
// =============================================================================

import pg from 'pg'

const { Pool, types } = pg

// --- Make pg return mysql2-compatible JS values -----------------------------
// boolean (oid 16) -> 1 / 0   (mysql2 returns tinyint(1) as 1/0)
types.setTypeParser(16, (v) => (v === 't' ? 1 : 0))
// bigint / int8 (oid 20) -> Number (mysql2 returns BIGINT as a JS number by default)
types.setTypeParser(20, (v) => (v === null ? null : Number(v)))
// NUMERIC/DECIMAL (1700) and DATE/TIMESTAMP are left at pg defaults, which already
// match mysql2 (decimal-as-string, timestamps as JS Date).

// --- Per-table ON CONFLICT targets ------------------------------------------
// Each table that the service upserts into (ON DUPLICATE KEY UPDATE) maps to the
// unique/primary key the upsert is designed to collide on. Derived from the
// Alluvi schema. Lower-cased table name -> conflict target SQL.
const CONFLICT_TARGETS = {
  products: '(id)',
  promo_codes: '(code)',
  affiliates: '(user_id)',
  users: '(email)',
  payments: '(provider, provider_id)',
  payment_sessions: '(session_id)',
  orders: '(order_number)',
}

// ---------------------------------------------------------------------------
// SQL translation helpers
// ---------------------------------------------------------------------------

// Replace `?` placeholders with `$1..$n`, skipping any `?` inside string
// literals ('...') or quoted identifiers ("..."). Returns the rewritten SQL.
function convertPlaceholders(sql) {
  let out = ''
  let i = 0
  let n = 1
  let inSingle = false
  let inDouble = false
  while (i < sql.length) {
    const ch = sql[i]
    if (inSingle) {
      out += ch
      if (ch === "'") {
        if (sql[i + 1] === "'") { out += "'"; i += 2; continue } // escaped ''
        inSingle = false
      }
      i++
      continue
    }
    if (inDouble) {
      out += ch
      if (ch === '"') inDouble = false
      i++
      continue
    }
    if (ch === "'") { inSingle = true; out += ch; i++; continue }
    if (ch === '"') { inDouble = true; out += ch; i++; continue }
    if (ch === '?') { out += '$' + n++; i++; continue }
    out += ch
    i++
  }
  return out
}

// Convert MySQL IF(cond, a, b) -> CASE WHEN cond THEN a ELSE b END.
// Parses balanced parentheses and splits on top-level commas; respects quotes.
function convertIf(sql) {
  for (let guard = 0; guard < 50; guard++) {
    const idx = findFunctionCall(sql, 'IF')
    if (idx === -1) return sql
    const open = idx + 2 // position of '('
    const args = splitCallArgs(sql, open)
    if (!args || args.parts.length !== 3) return sql // not the ternary form; leave it
    const [c, a, b] = args.parts
    const replacement = `CASE WHEN ${c.trim()} THEN ${a.trim()} ELSE ${b.trim()} END`
    sql = sql.slice(0, idx) + replacement + sql.slice(args.end + 1)
  }
  return sql
}

// Find an identifier function call (e.g. IF) at a word boundary, outside quotes.
// Returns the index of the function name, or -1.
function findFunctionCall(sql, name) {
  const upper = sql.toUpperCase()
  const target = name.toUpperCase()
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (inSingle) { if (ch === "'") inSingle = false; continue }
    if (inDouble) { if (ch === '"') inDouble = false; continue }
    if (ch === "'") { inSingle = true; continue }
    if (ch === '"') { inDouble = true; continue }
    if (upper.startsWith(target, i)) {
      const before = i === 0 ? ' ' : sql[i - 1]
      let j = i + target.length
      while (j < sql.length && /\s/.test(sql[j])) j++
      const boundaryBefore = !/[A-Za-z0-9_]/.test(before)
      if (boundaryBefore && sql[j] === '(') return i
    }
  }
  return -1
}

// Given the index of an opening '(', split its arguments on top-level commas.
// Returns { parts: string[], end: indexOfClosingParen } or null.
function splitCallArgs(sql, openParenIdx) {
  let depth = 0
  let inSingle = false
  let inDouble = false
  const parts = []
  let cur = ''
  for (let i = openParenIdx; i < sql.length; i++) {
    const ch = sql[i]
    if (inSingle) { cur += ch; if (ch === "'") inSingle = false; continue }
    if (inDouble) { cur += ch; if (ch === '"') inDouble = false; continue }
    if (ch === "'") { inSingle = true; cur += ch; continue }
    if (ch === '"') { inDouble = true; cur += ch; continue }
    if (ch === '(') { depth++; if (depth === 1) continue; cur += ch; continue }
    if (ch === ')') { depth--; if (depth === 0) { parts.push(cur); return { parts, end: i } } cur += ch; continue }
    if (ch === ',' && depth === 1) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  return null
}

// Keywords/functions that must NOT be treated as existing-row column references
// when qualifying bare identifiers inside an ON CONFLICT DO UPDATE SET clause.
const SET_RHS_KEYWORDS = new Set([
  'EXCLUDED', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'IS',
  'NULL', 'TRUE', 'FALSE', 'IN', 'LIKE', 'BETWEEN', 'DISTINCT', 'COALESCE',
  'NULLIF', 'GREATEST', 'LEAST', 'NOW', 'CURRENT_TIMESTAMP', 'CURRENT_DATE',
  'CURRENT_TIME', 'INTERVAL', 'CAST', 'DEFAULT',
])

// Split a string on a delimiter char at paren-depth 0, respecting quotes.
function splitTopLevel(str, delim) {
  const out = []
  let cur = ''
  let depth = 0
  let inS = false
  let inD = false
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (inS) { cur += ch; if (ch === "'") inS = false; continue }
    if (inD) { cur += ch; if (ch === '"') inD = false; continue }
    if (ch === "'") { inS = true; cur += ch; continue }
    if (ch === '"') { inD = true; cur += ch; continue }
    if (ch === '(') { depth++; cur += ch; continue }
    if (ch === ')') { depth--; cur += ch; continue }
    if (ch === delim && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

// Index of the first '=' at paren-depth 0 outside quotes (the assignment operator).
function firstTopLevelEquals(str) {
  let depth = 0
  let inS = false
  let inD = false
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (inS) { if (ch === "'") inS = false; continue }
    if (inD) { if (ch === '"') inD = false; continue }
    if (ch === "'") { inS = true; continue }
    if (ch === '"') { inD = true; continue }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === '=' && depth === 0) return i
  }
  return -1
}

// Qualify bare identifiers in an expression that reference the EXISTING row
// (e.g. `phone` -> `users.phone`) so Postgres doesn't treat them as ambiguous
// between the target table and the EXCLUDED pseudo-table. Skips quoted strings,
// dotted refs (a.b / EXCLUDED.b), function calls name(...) and SQL keywords.
function qualifyExistingRowRefs(expr, table) {
  let out = ''
  let i = 0
  let inS = false
  let inD = false
  while (i < expr.length) {
    const ch = expr[i]
    if (inS) { out += ch; if (ch === "'") inS = false; i++; continue }
    if (inD) { out += ch; if (ch === '"') inD = false; i++; continue }
    if (ch === "'") { inS = true; out += ch; i++; continue }
    if (ch === '"') { inD = true; out += ch; i++; continue }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j++
      const word = expr.slice(i, j)
      const prev = i > 0 ? expr[i - 1] : ''
      let k = j
      while (k < expr.length && /\s/.test(expr[k])) k++
      const nextNonSpace = expr[k] || ''
      const skip = prev === '.' || nextNonSpace === '(' || nextNonSpace === '.' || SET_RHS_KEYWORDS.has(word.toUpperCase())
      out += skip ? word : `${table}.${word}`
      i = j
      continue
    }
    out += ch
    i++
  }
  return out
}

// Qualify existing-row references on the RHS of each assignment in a SET clause,
// leaving the assignment targets (LHS) bare as Postgres requires.
function qualifySetClause(setClause, table) {
  return splitTopLevel(setClause, ',')
    .map((assignment) => {
      const idx = firstTopLevelEquals(assignment)
      if (idx === -1) return assignment
      return assignment.slice(0, idx + 1) + qualifyExistingRowRefs(assignment.slice(idx + 1), table)
    })
    .join(',')
}

// Translate MySQL DDL (CREATE TABLE / ALTER TABLE) to Postgres.
function translateDdl(sql) {
  let s = sql

  // Strip MySQL table options: ENGINE=... DEFAULT CHARSET=... COLLATE=...
  s = s.replace(/ENGINE\s*=\s*\w+/gi, '')
  s = s.replace(/DEFAULT\s+CHARSET\s*=\s*\w+/gi, '')
  s = s.replace(/(DEFAULT\s+)?COLLATE\s*=\s*\w+/gi, '')
  s = s.replace(/CHARACTER\s+SET\s*=\s*\w+/gi, '')

  // Postgres has no UNSIGNED / ZEROFILL integer attributes — strip them first so
  // the auto-increment patterns below match (e.g. "BIGINT UNSIGNED NOT NULL AUTO_INCREMENT").
  s = s.replace(/\bUNSIGNED\b/gi, '')
  s = s.replace(/\bZEROFILL\b/gi, '')

  // Auto-increment integer keys (tolerate a NOT NULL between the type and AUTO_INCREMENT).
  s = s.replace(/\bBIGINT(?:\s+NOT\s+NULL)?\s+AUTO_INCREMENT\b/gi, 'BIGSERIAL')
  s = s.replace(/\b(?:INT|INTEGER)(?:\s+NOT\s+NULL)?\s+AUTO_INCREMENT\b/gi, 'SERIAL')
  s = s.replace(/\bAUTO_INCREMENT\b/gi, '')

  // Type mappings.
  s = s.replace(/\bDATETIME\b/gi, 'TIMESTAMPTZ')
  s = s.replace(/\bTINYINT\s*\(\s*\d+\s*\)/gi, 'SMALLINT')
  s = s.replace(/\bTINYINT\b/gi, 'SMALLINT')
  s = s.replace(/\bJSON\b/gi, 'JSONB') // \bJSON\b won't touch JSONB
  s = s.replace(/\bON\s+UPDATE\s+CURRENT_TIMESTAMP\b/gi, '')

  // UNIQUE KEY <name> (cols)  ->  CONSTRAINT <name> UNIQUE (cols)   (table body + ALTER ADD)
  s = s.replace(/\bADD\s+UNIQUE\s+KEY\s+(\w+)\s*\(([^)]*)\)/gi, 'ADD CONSTRAINT $1 UNIQUE ($2)')
  s = s.replace(/\bUNIQUE\s+KEY\s+(\w+)\s*\(([^)]*)\)/gi, 'CONSTRAINT $1 UNIQUE ($2)')

  // Drop inline INDEX / KEY / FULLTEXT definitions (Postgres has no inline index).
  s = s.replace(/,\s*(?:FULLTEXT\s+)?(?:INDEX|KEY)\s+\w+\s*\([^)]*\)/gi, '')
  s = s.replace(/^\s*(?:FULLTEXT\s+)?(?:INDEX|KEY)\s+\w+\s*\([^)]*\)\s*,?/gim, '')

  // Clean dangling commas before a closing paren.
  s = s.replace(/,(\s*)\)/g, '$1)')

  return s
}

// Top-level translation entry point. Returns the Postgres SQL string.
function translate(sql) {
  let s = String(sql)

  // backtick identifiers -> double-quoted identifiers
  if (s.includes('`')) s = s.replace(/`/g, '"')

  const leading = s.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*/, '')
  const firstWord = (leading.match(/^([A-Za-z]+)/) || [, ''])[1].toUpperCase()
  const isDdl = firstWord === 'CREATE' || firstWord === 'ALTER' || firstWord === 'DROP'
  const isInsert = firstWord === 'INSERT'
  const isUpdate = firstWord === 'UPDATE'
  const isDelete = firstWord === 'DELETE'

  if (isDdl) {
    s = translateDdl(s)
  }

  // Postgres doesn't support a trailing LIMIT on UPDATE/DELETE. The MySQL code
  // only uses it defensively on queries whose WHERE clause already targets a
  // unique key (id / order_number / user_id / session_id), so dropping the
  // clause preserves behavior rather than changing which rows are affected.
  if (isUpdate || isDelete) {
    s = s.replace(/\s+LIMIT\s+\d+\s*;?\s*$/i, '')
  }

  // DATE_ADD(expr, INTERVAL n unit) -> (expr + INTERVAL 'n unit')
  s = s.replace(
    /\bDATE_ADD\s*\(\s*([^,]+?)\s*,\s*INTERVAL\s+(\d+)\s+(\w+)\s*\)/gi,
    (_m, expr, num, unit) => `(${expr} + INTERVAL '${num} ${unit}')`,
  )

  // IF(a,b,c) -> CASE WHEN a THEN b ELSE c END
  if (/\bIF\s*\(/i.test(s)) s = convertIf(s)

  let insertIgnore = false
  if (isInsert) {
    // INSERT IGNORE INTO -> INSERT INTO  (+ ON CONFLICT DO NOTHING later)
    if (/\bINSERT\s+IGNORE\s+INTO\b/i.test(s)) {
      s = s.replace(/\bINSERT\s+IGNORE\s+INTO\b/gi, 'INSERT INTO')
      insertIgnore = true
    }

    // ON DUPLICATE KEY UPDATE ... -> ON CONFLICT (<target>) DO UPDATE SET ...
    const dupMatch = s.match(/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i)
    if (dupMatch) {
      const tableMatch = s.match(/INSERT\s+INTO\s+"?(\w+)"?/i)
      const table = tableMatch ? tableMatch[1].toLowerCase() : ''
      const target = CONFLICT_TARGETS[table]
      if (!target) {
        throw new Error(`db-adapter: no ON CONFLICT target configured for table "${table}". Add it to CONFLICT_TARGETS.`)
      }
      const head = s.slice(0, dupMatch.index)
      let setClause = s.slice(dupMatch.index + dupMatch[0].length)
      // VALUES(col) -> EXCLUDED.col   (the proposed/insert row)
      setClause = setClause.replace(/\bVALUES\s*\(\s*"?(\w+)"?\s*\)/gi, 'EXCLUDED.$1')
      // Bare existing-row refs (e.g. COALESCE(EXCLUDED.phone, phone)) -> table.phone
      setClause = qualifySetClause(setClause, table)
      s = `${head} ON CONFLICT ${target} DO UPDATE SET ${setClause}`
    }

    // Trim trailing whitespace/semicolons before appending clauses.
    s = s.replace(/\s*;?\s*$/, '')

    if (insertIgnore && !/\bON\s+CONFLICT\b/i.test(s)) {
      s += ' ON CONFLICT DO NOTHING'
    }
    // Append RETURNING * so result.insertId / affectedRows behave like mysql2.
    if (!/\bRETURNING\b/i.test(s)) {
      s += ' RETURNING *'
    }
  }

  // Positional placeholders last (after all structural rewrites).
  s = convertPlaceholders(s)
  return s
}

// Build a mysql2-style result tuple from a pg result.
function buildResult(res) {
  const fields = res.fields || []
  if (res.command === 'SELECT' || res.command === 'SHOW') {
    return [res.rows, fields]
  }
  // INSERT / UPDATE / DELETE / CREATE / ALTER ...
  const first = Array.isArray(res.rows) && res.rows.length ? res.rows[0] : null
  const okPacket = {
    affectedRows: res.rowCount == null ? 0 : res.rowCount,
    changedRows: res.rowCount == null ? 0 : res.rowCount,
    insertId: first && first.id != null ? first.id : 0,
    rows: res.rows || [],
    fieldCount: 0,
    warningStatus: 0,
  }
  return [okPacket, fields]
}

async function runQuery(executor, sql, params) {
  const text = translate(sql)
  const values = params === undefined ? undefined : params
  try {
    const res = await executor(text, values)
    return buildResult(res)
  } catch (err) {
    if (process.env.DB_ADAPTER_DEBUG) {
      console.error('[db-adapter] query failed:', err.message, '\nSQL:', text, '\nVALUES:', JSON.stringify(values))
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Pool / connection wrappers
// ---------------------------------------------------------------------------

function wrapConnection(client) {
  return {
    async execute(sql, params) {
      return runQuery((t, v) => client.query(t, v), sql, params)
    },
    async query(sql, params) {
      return runQuery((t, v) => client.query(t, v), sql, params)
    },
    async beginTransaction() {
      await client.query('BEGIN')
    },
    async commit() {
      await client.query('COMMIT')
    },
    async rollback() {
      await client.query('ROLLBACK')
    },
    release() {
      try { client.release() } catch { /* ignore double-release */ }
    },
    // mysql2 debug field; some callers log it.
    threadId: client.processID || 0,
  }
}

// Map a mysql2 createPool config to a pg Pool config.
function toPgConfig(cfg = {}) {
  const out = {
    max: cfg.connectionLimit || 20,
    connectionTimeoutMillis: cfg.connectTimeout || 10000,
    idleTimeoutMillis: 30000,
    // Pin every connection to UTC at startup (no extra round-trip / no query race),
    // so naive 'YYYY-MM-DD HH:MM:SS' timestamps map to the instants MySQL stored.
    options: '-c timezone=UTC',
  }
  if (cfg.connectionString) {
    out.connectionString = cfg.connectionString
  } else {
    out.host = cfg.host
    out.port = cfg.port
    out.user = cfg.user
    out.password = cfg.password
    out.database = cfg.database
  }
  if (cfg.ssl) out.ssl = cfg.ssl
  return out
}

function createPool(cfg) {
  const pool = new Pool(toPgConfig(cfg))

  // Prevent idle-client errors from crashing the process.
  pool.on('error', (err) => {
    console.error('[DB] Pool error:', err?.message || err)
  })

  return {
    async execute(sql, params) {
      return runQuery((t, v) => pool.query(t, v), sql, params)
    },
    async query(sql, params) {
      return runQuery((t, v) => pool.query(t, v), sql, params)
    },
    async getConnection() {
      const client = await pool.connect()
      return wrapConnection(client)
    },
    // mysql2 pools are EventEmitters; emulate the subset the app subscribes to.
    on(event, handler) {
      if (event === 'error') pool.on('error', handler)
      // 'connection' / 'enqueue' are debug-only in the app; safely ignored.
      return this
    },
    async end() {
      await pool.end()
    },
    // Escape hatch if any caller needs the raw pg pool.
    _pgPool: pool,
  }
}

// Mirror `mysql2/promise` default export shape: `import mysql from ...; mysql.createPool(...)`
const mysqlCompat = { createPool }
export default mysqlCompat
export { createPool, translate }
