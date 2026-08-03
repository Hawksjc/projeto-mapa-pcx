#!/usr/bin/env node
"use strict";

/* ============================================================================
 * MAPA DE EMPREENDIMENTOS -- SDUH/PE
 * Arquivo unico de codigo-fonte (server.js).
 *
 * Este projeto contem APENAS a funcionalidade de mapa. Toda a integracao
 * com o PostgreSQL/PostGIS utilizada pelo mapa foi preservada sem alteracoes
 * de comportamento (mesmas consultas SQL, mesmos endpoints, mesma logica de
 * resolucao de colunas e conversao de geometria).
 * ==========================================================================*/

/* ### REGIAO: IMPORTS ### */
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const { Pool } = require("pg");
const format = require("pg-format");

/* ### REGIAO: CONFIGURACAO / VARIAVEIS DE AMBIENTE ### */
const CONFIG = {
  PORT: parseInt(process.env.PORT || "3000", 10),
  DATABASE_URL: process.env.DATABASE_URL || "",
  NODE_ENV: process.env.NODE_ENV || "production",
  TRUST_PROXY:
    process.env.TRUST_PROXY !== undefined
      ? process.env.TRUST_PROXY === "1"
      : (process.env.NODE_ENV || "production") === "production",
};

const REQUIRED_ENV = ["DATABASE_URL"];
const missingEnv = REQUIRED_ENV.filter((k) => !CONFIG[k]);
if (missingEnv.length) {
  console.error(
    "[BOOT] Variaveis de ambiente obrigatorias ausentes: " +
      missingEnv.join(", "),
  );
  console.error(
    "[BOOT] Consulte README.md / .env.example. A aplicacao nao sera iniciada.",
  );
  process.exit(1);
}

/* ### REGIAO: LOGGER SIMPLES ### */
const LOG_RING = [];
const LOG_RING_MAX = 2000;
function logEvent(level, category, message, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    category,
    message,
    meta: meta || null,
  };
  LOG_RING.push(entry);
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.shift();
  const line =
    "[" +
    entry.ts +
    "] [" +
    level.toUpperCase() +
    "] [" +
    category +
    "] " +
    message;
  if (level === "error") console.error(line, meta || "");
  else console.log(line);
}

/* ### REGIAO: UTILITARIOS DE VALIDACAO ### */
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
function isValidIdentifier(name) {
  return typeof name === "string" && IDENTIFIER_RE.test(name);
}
function sanitizeIdentifierOrThrow(name, kind) {
  if (!isValidIdentifier(name)) {
    const err = new Error(
      "Nome de " +
        (kind || "identificador") +
        ' invalido: "' +
        name +
        '". Use apenas letras, numeros e underscore, comecando com letra ou underscore (max 63 caracteres).',
    );
    err.code = "INVALID_IDENTIFIER";
    err.httpStatus = 400;
    throw err;
  }
  return name;
}

/* ### REGIAO: BANCO DE DADOS (POSTGRESQL) ### */
const pool = new Pool({
  connectionString: CONFIG.DATABASE_URL,
  ssl:
    /sslmode=require/.test(CONFIG.DATABASE_URL) ||
    /supabase\.co/.test(CONFIG.DATABASE_URL)
      ? { rejectUnauthorized: false }
      : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
pool.on("error", (err) => {
  logEvent("error", "db", "Erro no pool PostgreSQL", { error: err.message });
});

/* app_settings e a unica tabela de sistema que o mapa precisa: guarda a
 * escolha de schema/tabela/coluna espacial feita pelo usuario na tela de
 * configuracao do mapa. */
async function ensureSystemTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`);
  logEvent("info", "db", "Tabela app_settings verificada/criada.");
}

async function getAppSetting(key) {
  const { rows } = await pool.query(
    `SELECT value FROM app_settings WHERE key = $1;`,
    [key],
  );
  return rows.length ? rows[0].value : null;
}
async function setAppSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now();`,
    [key, JSON.stringify(value)],
  );
}

async function listUserTables() {
  const { rows } = await pool.query(`SELECT table_name,
    (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS column_count
    FROM information_schema.tables t WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;`);
  return rows;
}

async function getTableColumns(tableName) {
  sanitizeIdentifierOrThrow(tableName, "tabela");
  const { rows } = await pool.query(
    `SELECT column_name, data_type, is_nullable
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position;`,
    [tableName],
  );
  return rows;
}

/* Versao generica de getTableColumns que aceita qualquer schema (nao so
 * "public") e enxerga tabelas, views e materialized views igualmente --
 * usada pela funcionalidade de Mapa. */
async function getSchemaTableColumns(schema, tableName) {
  sanitizeIdentifierOrThrow(schema, "schema");
  sanitizeIdentifierOrThrow(tableName, "tabela");
  const { rows } = await pool.query(
    `SELECT a.attname AS column_name
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum;`,
    [schema, tableName],
  );
  return rows.map((r) => r.column_name);
}

async function getTableRowCount(tableName) {
  sanitizeIdentifierOrThrow(tableName, "tabela");
  const { rows } = await pool.query(
    format("SELECT count(*)::int AS count FROM %I;", tableName),
  );
  return rows[0].count;
}

async function previewTable(tableName, limit) {
  sanitizeIdentifierOrThrow(tableName, "tabela");
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
  const { rows } = await pool.query(
    format("SELECT * FROM %I LIMIT %L;", tableName, safeLimit),
  );
  return rows;
}

/* ### REGIAO: EXPRESS APP ### */
const app = express();
app.use(express.static(path.join(__dirname)));
if (CONFIG.TRUST_PROXY) app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));

/* ### REGIAO: ASSETS ESTATICOS DO MAPA (LEAFLET, 100% LOCAL) ###
 * O mapa usa Leaflet + Leaflet.markercluster instalados via NPM e servidos
 * diretamente pelo Express a partir de node_modules -- NENHUM arquivo de
 * biblioteca e carregado por CDN externo. Isso evita o erro "Nao foi
 * possivel carregar a biblioteca do mapa", comum em redes corporativas que
 * bloqueiam dominios de CDN. Requer que as dependencias tenham sido
 * instaladas com "npm install" (ver package.json / README). */
const LEAFLET_DIST = path.join(__dirname, "node_modules", "leaflet", "dist");
const LEAFLET_CLUSTER_DIST = path.join(
  __dirname,
  "node_modules",
  "leaflet.markercluster",
  "dist",
);
try {
  if (!fs.existsSync(path.join(LEAFLET_DIST, "leaflet.js"))) {
    console.warn(
      "[BOOT] node_modules/leaflet nao encontrado ou incompleto. Rode 'npm install' " +
        "(dependencias: leaflet, leaflet.markercluster) para o mapa funcionar.",
    );
  }
  if (
    !fs.existsSync(path.join(LEAFLET_CLUSTER_DIST, "leaflet.markercluster.js"))
  ) {
    console.warn(
      "[BOOT] node_modules/leaflet.markercluster nao encontrado ou incompleto. Rode 'npm install'.",
    );
  }
  app.use("/vendor/leaflet", express.static(LEAFLET_DIST));
  app.use(
    "/vendor/leaflet.markercluster",
    express.static(LEAFLET_CLUSTER_DIST),
  );
  console.log(
    "[BOOT] Assets locais do Leaflet configurados em /vendor/leaflet e /vendor/leaflet.markercluster (sem dependencia de CDN externo).",
  );
} catch (err) {
  console.error(
    "[BOOT] Falha ao configurar assets locais do Leaflet. O mapa nao vai funcionar ate 'npm install' ser executado.",
    err,
  );
}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  /* NOTA (mapa): script-src e style-src permanecem restritos a 'self', ja
   * que a biblioteca do mapa (Leaflet) e servida localmente pelo Express
   * (ver /vendor/leaflet e /vendor/leaflet.markercluster) -- nenhum script
   * externo e carregado. img-src e connect-src precisam liberar os
   * provedores de tiles/geocodificacao (imagens de mapa e busca de
   * endereco), que continuam sendo servicos externos por natureza. */
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com https://server.arcgisonline.com https://*.tile.opentopomap.org; " +
      "connect-src 'self' https://nominatim.openstreetmap.org;",
  );
  if (CONFIG.NODE_ENV === "production")
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains",
    );
  next();
});

/* ### REGIAO: API - POSTGRESQL (GENERICO, USADO PELA TELA DE SELECAO DO MAPA) ### */
app.get("/api/db/tables", async (req, res) => {
  try {
    const tables = await listUserTables();
    res.json({ tables });
  } catch (err) {
    logEvent("error", "db", "Falha ao listar tabelas", { error: err.message });
    res.status(500).json({
      error: "Nao foi possivel conectar ou listar as tabelas: " + err.message,
    });
  }
});

app.get("/api/db/tables/:tableName/preview", async (req, res) => {
  try {
    const { tableName } = req.params;
    sanitizeIdentifierOrThrow(tableName, "tabela");
    const columns = await getTableColumns(tableName);
    if (columns.length === 0)
      return res.status(404).json({ error: "Tabela nao encontrada." });
    const rowCount = await getTableRowCount(tableName);
    const rows = await previewTable(tableName, 10);
    res.json({ columns, rowCount, rows });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ error: err.message });
  }
});

/* ### REGIAO: API - MAPA DE EMPREENDIMENTOS ###
 * A fonte de dados do mapa (schema + tabela + coluna espacial PostGIS) NAO
 * fica fixa em uma tabela: o usuario escolhe na tela, e a escolha fica salva
 * em app_settings. Para descobrir quais colunas sao espaciais, usamos as
 * views de catalogo do proprio PostGIS (geometry_columns / geography_columns),
 * que listam automaticamente TODAS as colunas geometry/geography do banco,
 * em qualquer schema/tabela -- nao precisamos adivinhar nomes de coluna.
 *
 * Os demais campos (titulo, status, municipio etc.) continuam usando a
 * resolucao por candidatos, agora aplicada a tabela que o usuario escolheu. */
const MAP_CONFIG_KEY = "map_data_source";
/* Fonte padrao do mapa: SELECT * FROM public.predio_caixao, coluna espacial "geom".
 * Usada apenas quando o usuario ainda nao configurou nenhuma fonte em app_settings
 * (tela de configuracao do mapa). Se a coluna configurada deixar de ser valida
 * (ex: tabela renomeada), o endpoint /api/mapa volta a pedir configuracao. */
const DEFAULT_MAP_CONFIG = {
  schema: "public",
  table: "predio_caixao",
  column: "geom",
};
const MAP_FIELD_CANDIDATES = {
  /* "name" tem prioridade porque tabelas geradas a partir de shapefile/KML
   * (caso de "predio_caixao") normalmente trazem colunas em ingles. */
  titulo: ["name", "nome", "titulo", "empreendimento", "nome_empreendimento"],
  layer: ["layer", "camada"],
  municipio: ["municipio", "cidade"],
  status: ["status", "situacao_obra", "etapa"],
  modalidade: ["modalidade", "programa"],
  destinacao: ["destinacao", "destinação", "destinacao_unidades"],
  situacao: ["situacao", "situacao_atual"],
  gestor: ["gestor", "responsavel", "gestor_responsavel"],
  construtora: ["construtora", "empresa", "empreendimento_empresa"],
  valor: ["valor", "valor_total", "valor_investimento"],
  percentual_execucao: [
    "percentual_execucao",
    "percentual_obra",
    "percentual_conclusao",
    "andamento",
  ],
  ultima_atualizacao: [
    "ultima_atualizacao",
    "atualizado_em",
    "updated_at",
    "data_atualizacao",
  ],
  autorizado: ["autorizado"],
};
/* A interface do mapa expoe apenas 3 filtros: Destinacao e Layer (selecao
 * exata, via dropdown) e Name (busca parcial, via ILIKE sobre a coluna
 * resolvida em "titulo"). */
const MAP_EXACT_FILTER_FIELDS = ["destinacao", "layer"];

/* Lista todas as colunas espaciais (geometry/geography) que o PostGIS conhece
 * no banco inteiro, em qualquer schema/tabela -- e a fonte usada para o
 * usuario escolher "tabela + coluna" na tela. */
async function listSpatialColumns() {
  const ext = await pool.query(
    `SELECT 1 FROM pg_extension WHERE extname = 'postgis';`,
  );
  if (ext.rows.length === 0) {
    const err = new Error(
      "A extensao PostGIS nao parece estar habilitada neste banco (CREATE EXTENSION postgis).",
    );
    err.httpStatus = 400;
    throw err;
  }
  const { rows } = await pool.query(`
    SELECT f_table_schema AS schema, f_table_name AS "table", f_geometry_column AS "column",
           'geometry' AS kind, srid, type
    FROM geometry_columns
    UNION ALL
    SELECT f_table_schema AS schema, f_table_name AS "table", f_geography_column AS "column",
           'geography' AS kind, srid, type
    FROM geography_columns
    ORDER BY 1, 2, 3;
  `);
  return rows;
}

async function getMapConfig() {
  const saved = await getAppSetting(MAP_CONFIG_KEY);
  return saved || DEFAULT_MAP_CONFIG;
}

/* Reconfirma que schema/tabela/coluna salvos ainda apontam para uma coluna
 * espacial de verdade (protege contra configuracao desatualizada, ex: coluna
 * removida ou tabela recriada). */
async function resolveConfiguredSpatialColumn(config) {
  if (!config || !config.schema || !config.table || !config.column) return null;
  const spatialCols = await listSpatialColumns();
  return (
    spatialCols.find(
      (c) =>
        c.schema === config.schema &&
        c.table === config.table &&
        c.column === config.column,
    ) || null
  );
}

/* Converte a coluna espacial para latitude/longitude em WGS84 (EPSG:4326).
 * "geography" ja e sempre WGS84; "geometry" pode estar em outro SRID e
 * precisa de ST_Transform antes de extrair X/Y.
 *
 * IMPORTANTE: ST_X()/ST_Y() so aceitam geometria do tipo Point -- se a
 * coluna guardar Polygon/MultiPolygon (ex: contorno de um predio, como em
 * "predio_caixao") elas retornam NULL (ou erro, dependendo da versao do
 * PostGIS), e nenhum registro aparece no mapa. Por isso extraimos sempre um
 * ponto representativo com ST_PointOnSurface antes de pegar as coordenadas:
 * para um Point ele devolve o proprio ponto; para Polygon/MultiPolygon/Line
 * devolve um ponto garantidamente sobre a geometria (melhor que centroide,
 * que pode cair fora de poligonos concavos). ST_Force2D remove a dimensao Z
 * (comum em geometrias exportadas do Caixa/CEHAB) para evitar problemas com
 * funcoes do GEOS que esperam 2D.
 */
function buildLatLngExpr(spatialCol, alias) {
  const colRef = format("%I.%I", alias, spatialCol.column);
  let geomExpr;
  if (spatialCol.kind === "geography") {
    geomExpr = colRef + "::geometry";
  } else if (
    spatialCol.srid &&
    Number(spatialCol.srid) !== 4326 &&
    Number(spatialCol.srid) !== 0
  ) {
    geomExpr = format("ST_Transform(%s, 4326)", colRef);
  } else {
    geomExpr = colRef;
  }
  const pointExpr = format("ST_PointOnSurface(ST_Force2D(%s))", geomExpr);
  /* Geometria completa (para Polygon/MultiPolygon) em GeoJSON, na mesma
   * normalizacao ja usada acima para o ponto representativo: reprojetada
   * para WGS84 (ST_Transform, quando necessario) e com ST_Force2D (remove
   * a dimensao Z). Nao ha simplificacao nem geracao de geometria nova -- e a
   * mesma geometria gravada no banco, apenas convertida para o formato que o
   * Leaflet consegue desenhar (GeoJSON). Usada para exibir o poligono do
   * empreendimento permanentemente no mapa (Problema 2). */
  const force2dExpr = format("ST_Force2D(%s)", geomExpr);
  return {
    latSql: format("ST_Y(%s)", pointExpr),
    lngSql: format("ST_X(%s)", pointExpr),
    geomGeoJsonSql: format("ST_AsGeoJSON(%s)", force2dExpr),
  };
}

async function resolveMapColumns(schema, table) {
  const realCols = await getSchemaTableColumns(schema, table);
  const realColsLower = realCols.map((c) => c.toLowerCase());
  const resolved = {};
  Object.entries(MAP_FIELD_CANDIDATES).forEach(([logical, candidates]) => {
    const match = candidates.find((c) =>
      realColsLower.includes(c.toLowerCase()),
    );
    resolved[logical] = match
      ? realCols[realColsLower.indexOf(match.toLowerCase())]
      : null;
  });
  return resolved;
}

function buildMapFilterClause(query, cols, alias) {
  const filters = [];
  if (cols.autorizado)
    filters.push(format("%I.%I = true", alias, cols.autorizado));
  /* Destinacao e Layer: selecao exata (dropdown na interface). */
  MAP_EXACT_FILTER_FIELDS.forEach((f) => {
    if (query[f] && cols[f])
      filters.push(format("%I.%I = %L", alias, cols[f], query[f]));
  });
  /* Name: busca parcial (contains) sobre a coluna resolvida em "titulo". */
  if (query.name && cols.titulo)
    filters.push(
      format("%I.%I ILIKE %L", alias, cols.titulo, "%" + query.name + "%"),
    );
  return filters.join(" AND ");
}

/* ---- Configuracao da fonte de dados (tabela + coluna espacial) ---- */
app.get("/api/mapa/fontes", async (req, res) => {
  try {
    const fontes = await listSpatialColumns();
    res.json({ fontes });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ error: err.message });
  }
});

app.get("/api/mapa/config", async (req, res) => {
  try {
    const config = await getMapConfig();
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/mapa/config", async (req, res) => {
  try {
    const { schema, table, column } = req.body || {};
    if (!schema || !table || !column)
      return res
        .status(400)
        .json({ error: "Informe schema, tabela e coluna." });
    const spatialCol = await resolveConfiguredSpatialColumn({
      schema,
      table,
      column,
    });
    if (!spatialCol)
      return res.status(400).json({
        error:
          "Essa coluna nao e uma coluna espacial (geometry/geography) valida.",
      });
    await setAppSetting(MAP_CONFIG_KEY, { schema, table, column });
    logEvent("info", "mapa", "Fonte de dados do mapa configurada", {
      schema,
      table,
      column,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ error: err.message });
  }
});

/* ---- Dados do mapa ---- */
app.get("/api/mapa", async (req, res) => {
  console.log("[mapa] GET /api/mapa - filtros recebidos:", req.query);
  try {
    const config = await getMapConfig();
    if (!config) {
      console.warn("[mapa] Nenhuma fonte de dados configurada ainda.");
      return res.status(409).json({
        needsConfig: true,
        error: "Nenhuma fonte de dados configurada para o mapa ainda.",
      });
    }
    const spatialCol = await resolveConfiguredSpatialColumn(config);
    if (!spatialCol) {
      console.warn(
        "[mapa] Fonte configurada nao e mais uma coluna espacial valida:",
        config,
      );
      return res.status(409).json({
        needsConfig: true,
        error:
          "A fonte de dados configurada nao e mais uma coluna espacial valida. Selecione novamente.",
      });
    }
    console.log(
      `[mapa] Fonte: ${config.schema}.${config.table}.${config.column} (${spatialCol.kind}, SRID ${spatialCol.srid})`,
    );

    const alias = "t";
    const cols = await resolveMapColumns(config.schema, config.table);
    console.log("[mapa] Colunas resolvidas:", cols);
    const { latSql, lngSql, geomGeoJsonSql } = buildLatLngExpr(
      spatialCol,
      alias,
    );
    console.log(
      "[mapa] Conversao de geometria -> lat/lng:",
      `lat=${latSql}`,
      `lng=${lngSql}`,
    );
    const whereParts = [format("%I.%I IS NOT NULL", alias, spatialCol.column)];
    const extraWhere = buildMapFilterClause(req.query, cols, alias);
    if (extraWhere) whereParts.push(extraWhere);

    const selectParts = [
      latSql + " AS latitude",
      lngSql + " AS longitude",
      geomGeoJsonSql + " AS geom_geojson",
    ];
    Object.entries(cols).forEach(([logical, real]) => {
      if (real) selectParts.push(format("%I.%I AS %I", alias, real, logical));
    });

    const sql =
      "SELECT " +
      selectParts.join(", ") +
      " FROM " +
      format("%I.%I", config.schema, config.table) +
      " AS " +
      format("%I", alias) +
      " WHERE " +
      whereParts.join(" AND ") +
      " LIMIT 20000;";
    console.log("[mapa] SQL:", sql);
    const { rows } = await pool.query(sql);
    console.log(`[mapa] ${rows.length} linha(s) retornada(s) pelo banco.`);
    const items = rows
      .map((r) => {
        const { geom_geojson, ...rest } = r;
        /* Geometria completa (para exibir o poligono permanente no mapa --
         * Problema 2). So repassamos ao frontend quando o tipo for Polygon
         * ou MultiPolygon; para colunas que guardam apenas Point (ex: um
         * pino simples), nao ha poligono a desenhar e "geometry" fica null. */
        let geometry = null;
        if (geom_geojson) {
          try {
            const parsed = JSON.parse(geom_geojson);
            if (
              parsed &&
              (parsed.type === "Polygon" || parsed.type === "MultiPolygon")
            ) {
              geometry = parsed;
            }
          } catch (e) {
            logEvent(
              "error",
              "mapa",
              "Falha ao parsear geom_geojson de um registro",
              {
                error: e.message,
              },
            );
          }
        }
        return {
          ...rest,
          latitude: Number(r.latitude),
          longitude: Number(r.longitude),
          geometry,
        };
      })
      .filter(
        (r) =>
          Number.isFinite(r.latitude) &&
          Number.isFinite(r.longitude) &&
          Math.abs(r.latitude) <= 90 &&
          Math.abs(r.longitude) <= 180,
      );
    const discarded = rows.length - items.length;
    if (discarded > 0)
      console.warn(
        `[mapa] ${discarded} registro(s) descartado(s) por coordenadas invalidas/nulas apos a conversao de geometria.`,
      );
    console.log(`[mapa] ${items.length} registro(s) validos enviados ao mapa.`);
    res.json({ count: items.length, items, columns: cols, source: config });
  } catch (err) {
    console.error("[mapa] Falha ao carregar /api/mapa:", err);
    logEvent("error", "mapa", "Falha ao carregar /api/mapa", {
      error: err.message,
    });
    res.status(err.httpStatus || 500).json({
      error: "Nao foi possivel carregar os dados do mapa: " + err.message,
    });
  }
});

app.get("/api/mapa/filtros", async (req, res) => {
  try {
    const config = await getMapConfig();
    if (!config) return res.json({});
    const spatialCol = await resolveConfiguredSpatialColumn(config);
    if (!spatialCol) return res.json({});
    const cols = await resolveMapColumns(config.schema, config.table);
    const filterable = MAP_EXACT_FILTER_FIELDS.filter((f) => cols[f]);
    const out = {};
    for (const f of filterable) {
      const sql =
        "SELECT DISTINCT " +
        format("%I", cols[f]) +
        " AS value FROM " +
        format("%I.%I", config.schema, config.table) +
        " WHERE " +
        format("%I IS NOT NULL", cols[f]) +
        " ORDER BY 1 LIMIT 300;";
      const { rows } = await pool.query(sql);
      out[f] = rows.map((r) => r.value);
    }
    res.json(out);
  } catch (err) {
    logEvent("error", "mapa", "Falha ao carregar /api/mapa/filtros", {
      error: err.message,
    });
    res
      .status(500)
      .json({ error: "Nao foi possivel carregar as opcoes de filtro." });
  }
});

app.get("/healthz", async (req, res) => {
  try {
    await pool.query("SELECT 1;");
    res.json({ ok: true, db: "up" });
  } catch (err) {
    res.status(503).json({ ok: false, db: "down", error: err.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ### REGIAO: TRATAMENTO DE ERROS GLOBAL ### */
app.use((req, res) => {
  res.status(404).json({ error: "Rota nao encontrada." });
});

app.use((err, req, res, next) => {
  logEvent("error", "http", "Erro nao tratado", {
    error: err.message,
    stack: err.stack,
  });
  res
    .status(err.httpStatus || 500)
    .json({ error: "Erro interno do servidor." });
});

/* ### REGIAO: INICIALIZACAO DO SERVIDOR ### */
async function start() {
  try {
    await pool.query("SELECT 1;");
    logEvent("info", "boot", "Conexao com PostgreSQL verificada com sucesso.");
    await ensureSystemTables();
  } catch (err) {
    logEvent(
      "error",
      "boot",
      "Falha ao conectar ao PostgreSQL na inicializacao: " + err.message,
    );
    process.exit(1);
  }

  app.listen(CONFIG.PORT, () => {
    logEvent("info", "boot", "Servidor iniciado na porta " + CONFIG.PORT);
  });
}

process.on("unhandledRejection", (reason) => {
  logEvent("error", "process", "Unhandled Rejection", {
    reason: String(reason),
  });
});
process.on("uncaughtException", (err) => {
  logEvent("error", "process", "Uncaught Exception", { error: err.message });
});

start();
