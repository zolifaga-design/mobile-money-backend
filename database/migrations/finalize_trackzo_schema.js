const { QueryTypes } = require("sequelize");

async function tableExists(sequelize, tableName) {
    const rows = await sequelize.query(
        `SELECT 1
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = :tableName
         LIMIT 1`,
        {
            replacements: { tableName },
            type: QueryTypes.SELECT
        }
    );
    return rows.length > 0;
}

async function columnExists(sequelize, tableName, columnName) {
    const rows = await sequelize.query(
        `SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = :tableName
           AND column_name = :columnName
         LIMIT 1`,
        {
            replacements: { tableName, columnName },
            type: QueryTypes.SELECT
        }
    );
    return rows.length > 0;
}

async function addColumnIfMissing(sequelize, tableName, columnName, definition) {
    if (!(await tableExists(sequelize, tableName))) return;

    if (await columnExists(sequelize, tableName, columnName)) {
        console.log(`✓ ${tableName}.${columnName} existe déjà`);
        return;
    }

    await sequelize.query(
        `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${definition}`
    );
    console.log(`✅ Colonne ajoutée: ${tableName}.${columnName}`);
}

async function ensureSmsReceiptSchema(sequelize) {
    if (!(await tableExists(sequelize, "sms_receipts"))) {
        // sequelize.sync() est censé créer la table. On ne fabrique pas ici
        // une table concurrente avec une définition différente.
        return;
    }

    // Le modèle Sequelize attend ces colonnes. status était la cause du
    // SequelizeDatabaseError observé en production.
    await addColumnIfMissing(
        sequelize, "sms_receipts", "userId", `UUID`
    );
    await addColumnIfMissing(
        sequelize, "sms_receipts", "smsHash", `VARCHAR(64)`
    );
    await addColumnIfMissing(
        sequelize, "sms_receipts", "sender", `VARCHAR(255)`
    );
    await addColumnIfMissing(
        sequelize, "sms_receipts", "message", `TEXT`
    );
    await addColumnIfMissing(
        sequelize, "sms_receipts", "receivedAt", `BIGINT`
    );
    await addColumnIfMissing(
        sequelize, "sms_receipts", "status",
        `VARCHAR(20) NOT NULL DEFAULT 'PROCESSING'`
    );
    await addColumnIfMissing(
        sequelize, "sms_receipts", "createdAt",
        `TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP`
    );
    await addColumnIfMissing(
        sequelize, "sms_receipts", "updatedAt",
        `TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP`
    );

    // Nettoyage des éventuels doublons historiques avant de poser l'unicité.
    // On conserve en priorité COMPLETED, puis la ligne la plus ancienne.
    await sequelize.query(`
        WITH ranked AS (
            SELECT
                ctid,
                ROW_NUMBER() OVER (
                    PARTITION BY "smsHash"
                    ORDER BY
                        CASE WHEN "status" = 'COMPLETED' THEN 0 ELSE 1 END,
                        "createdAt" ASC,
                        ctid ASC
                ) AS rn
            FROM "sms_receipts"
            WHERE "smsHash" IS NOT NULL
        )
        DELETE FROM "sms_receipts" s
        USING ranked r
        WHERE s.ctid = r.ctid
          AND r.rn > 1
    `);

    // Une seule réception logique par hash. L'index est idempotent.
    await sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS sms_receipts_sms_hash_unique
        ON "sms_receipts" ("smsHash")
        WHERE "smsHash" IS NOT NULL
    `);

    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS sms_receipts_user_id_idx
        ON "sms_receipts" ("userId")
    `);

    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS sms_receipts_status_idx
        ON "sms_receipts" ("status")
    `);
}

async function finalizeTrackzoSchema(sequelize) {
    console.log("🔧 Vérification du schéma Trackzo...");

    // ==========================
    // DEVICES
    // ==========================
    await addColumnIfMissing(sequelize, "devices", "authTokenHash", `VARCHAR(64)`);
    if (await tableExists(sequelize, "devices")) {
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS devices_auth_token_hash_unique
            ON "devices" ("authTokenHash")
            WHERE "authTokenHash" IS NOT NULL
        `);
    }

    // ==========================
    // USER SETTINGS
    // ==========================
    const userSettingsColumns = [
        ["country", `VARCHAR(255) DEFAULT 'CI'`],
        ["openingTime", `VARCHAR(255) DEFAULT '08:00'`],
        ["closingTime", `VARCHAR(255) DEFAULT '22:00'`],
        ["dailySheetCreation", `VARCHAR(255) DEFAULT '00:05'`],
        ["timezone", `VARCHAR(255) DEFAULT 'Africa/Abidjan'`],
        ["scriptId", `VARCHAR(255)`],
        ["agentToken", `TEXT`],
        ["sheetId", `VARCHAR(255)`],
        ["sheetUrl", `TEXT`],
        ["sheetName", `VARCHAR(255)`],
        ["sheetCreated", `BOOLEAN DEFAULT FALSE`],
        ["lastTemplateVersion", `VARCHAR(255) DEFAULT '1.0'`],
        ["templateId", `UUID`]
    ];
    for (const [name, definition] of userSettingsColumns) {
        await addColumnIfMissing(sequelize, "user_settings", name, definition);
    }

    // ==========================
    // SMS RECEIPTS
    // ==========================
    await ensureSmsReceiptSchema(sequelize);

    // ==========================
    // DAILY SHEETS
    // ==========================
    await addColumnIfMissing(sequelize, "daily_sheets", "url", `TEXT`);
    await addColumnIfMissing(sequelize, "daily_sheets", "scriptId", `VARCHAR(255)`);

    if (await tableExists(sequelize, "daily_sheets")) {
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS daily_sheets_user_date_unique
            ON "daily_sheets" ("userId", "date")
        `);
    }

    // ==========================
    // GOOGLE ACCOUNTS
    // ==========================
    const googleColumns = [
        ["accessToken", `TEXT`],
        ["expiryDate", `BIGINT`],
        ["expiresAt", `TIMESTAMP WITH TIME ZONE`],
        ["trackzoFolderId", `VARCHAR(255)`],
        ["dailyFolderId", `VARCHAR(255)`],
        ["reportsFolderId", `VARCHAR(255)`]
    ];
    for (const [name, definition] of googleColumns) {
        await addColumnIfMissing(sequelize, "google_accounts", name, definition);
    }

    console.log("✅ Schéma Trackzo finalisé");
}

module.exports = { finalizeTrackzoSchema };
