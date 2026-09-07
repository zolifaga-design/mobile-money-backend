const { QueryTypes } = require("sequelize");

async function columnExists(sequelize, tableName, columnName) {
    const result = await sequelize.query(
        `
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = :tableName
          AND column_name = :columnName
        LIMIT 1
        `,
        {
            replacements: {
                tableName,
                columnName
            },
            type: QueryTypes.SELECT
        }
    );

    return result.length > 0;
}

async function addColumnIfMissing(
    sequelize,
    tableName,
    columnName,
    definition
) {
    const exists = await columnExists(
        sequelize,
        tableName,
        columnName
    );

    if (exists) {
        console.log(
            `✓ ${tableName}.${columnName} existe déjà`
        );
        return;
    }

    await sequelize.query(
        `
        ALTER TABLE "${tableName}"
        ADD COLUMN "${columnName}" ${definition}
        `
    );

    console.log(
        `✅ Colonne ajoutée: ${tableName}.${columnName}`
    );
}

async function ensureAllModelColumns(sequelize) {
    console.log("🔍 Vérification automatique des colonnes des modèles...");

    const models = Object.values(sequelize.models || {});
    const queryInterface = sequelize.getQueryInterface();

    for (const model of models) {
        const tableName = model.getTableName();
        const physicalTable = typeof tableName === "string" ? tableName : tableName.tableName;

        if (!physicalTable) continue;

        let existingColumns;
        try {
            existingColumns = await queryInterface.describeTable(physicalTable);
        } catch (error) {
            // sequelize.sync() doit normalement avoir créé la table.
            // On ne bloque pas le démarrage si une table n'existe pas encore.
            console.warn(`⚠️ Impossible de décrire ${physicalTable}: ${error.message}`);
            continue;
        }

        for (const [attributeName, attribute] of Object.entries(model.rawAttributes)) {
            const fieldName = attribute.field || attributeName;
            if (existingColumns[fieldName]) continue;

            // Pour une base déjà remplie, une nouvelle colonne NOT NULL sans
            // valeur par défaut ferait échouer le redémarrage. On l'ajoute donc
            // d'abord nullable; les nouvelles lignes utiliseront ensuite les
            // règles du modèle Sequelize.
            const definition = {
                type: attribute.type,
                allowNull: true
            };

            if (attribute.defaultValue !== undefined) {
                definition.defaultValue = attribute.defaultValue;
            }

            try {
                await queryInterface.addColumn(
                    physicalTable,
                    fieldName,
                    definition
                );
                console.log(`✅ Colonne auto-ajoutée: ${physicalTable}.${fieldName}`);
            } catch (error) {
                // Deux instances peuvent démarrer simultanément. Une autre
                // instance peut avoir créé la colonne entre describeTable et
                // addColumn; on vérifie alors à nouveau avant d'échouer.
                const refreshed = await queryInterface.describeTable(physicalTable);
                if (refreshed[fieldName]) {
                    console.log(`✓ ${physicalTable}.${fieldName} existe déjà`);
                } else {
                    throw error;
                }
            }
        }
    }
}

async function finalizeTrackzoSchema(sequelize) {

    console.log(
        "🔧 Vérification du schéma Trackzo..."
    );

    // ==========================================
    // DEVICES / AUTHENTIFICATION
    // ==========================================

    await addColumnIfMissing(
        sequelize,
        "devices",
        "authTokenHash",
        `VARCHAR(64)`
    );


    await sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS devices_auth_token_hash_unique
        ON "devices" ("authTokenHash")
        WHERE "authTokenHash" IS NOT NULL
    `);

    // ==========================================
    // USER SETTINGS
    // ==========================================

    await addColumnIfMissing(
        sequelize,
        "user_settings",
        "country",
        `VARCHAR(255) DEFAULT 'CI'`
    );

    await addColumnIfMissing(
        sequelize,
        "user_settings",
        "openingTime",
        `VARCHAR(255) DEFAULT '08:00'`
    );

    await addColumnIfMissing(
        sequelize,
        "user_settings",
        "closingTime",
        `VARCHAR(255) DEFAULT '22:00'`
    );

    await addColumnIfMissing(
        sequelize,
        "user_settings",
        "dailySheetCreation",
        `VARCHAR(255) DEFAULT '00:05'`
    );

    await addColumnIfMissing(
        sequelize,
        "user_settings",
        "timezone",
        `VARCHAR(255) DEFAULT 'Africa/Abidjan'`
    );

    await addColumnIfMissing(
        sequelize,
        "user_settings",
        "scriptId",
        `VARCHAR(255)`
    );

    await addColumnIfMissing(
        sequelize,
        "user_settings",
        "agentToken",
        `TEXT`
    );

    await addColumnIfMissing(
        sequelize,
        "user_settings",
        "sheetId",
        `VARCHAR(255)`
    );

    await addColumnIfMissing(
        sequelize,
        "user_settings",
        "sheetUrl",
        `TEXT`
    );

    await addColumnIfMissing(
        sequelize,
        "user_settings",
        "sheetName",
        `VARCHAR(255)`
    );

    await addColumnIfMissing(
        sequelize,
        "user_settings",
        "sheetCreated",
        `BOOLEAN DEFAULT FALSE`
    );

    await addColumnIfMissing(
        sequelize,
        "user_settings",
        "lastTemplateVersion",
        `VARCHAR(255) DEFAULT '1.0'`
    );

    await addColumnIfMissing(
        sequelize,
        "user_settings",
        "templateId",
        `UUID`
    );


    // ==========================================
    // SMS RECEIPTS
    // ==========================================

    await addColumnIfMissing(
        sequelize,
        "sms_receipts",
        "message",
        `TEXT`
    );


    // ==========================================
    // DAILY SHEETS
    // ==========================================

    await addColumnIfMissing(
        sequelize,
        "daily_sheets",
        "url",
        `TEXT`
    );

    await addColumnIfMissing(
        sequelize,
        "daily_sheets",
        "scriptId",
        `VARCHAR(255)`
    );


    // ==========================================
    // GOOGLE ACCOUNTS
    // ==========================================

    await addColumnIfMissing(
        sequelize,
        "google_accounts",
        "accessToken",
        `TEXT`
    );

    await addColumnIfMissing(
        sequelize,
        "google_accounts",
        "expiryDate",
        `BIGINT`
    );

    await addColumnIfMissing(
        sequelize,
        "google_accounts",
        "expiresAt",
        `TIMESTAMP WITH TIME ZONE`
    );

    await addColumnIfMissing(
        sequelize,
        "google_accounts",
        "trackzoFolderId",
        `VARCHAR(255)`
    );

    await addColumnIfMissing(
        sequelize,
        "google_accounts",
        "dailyFolderId",
        `VARCHAR(255)`
    );

    await addColumnIfMissing(
        sequelize,
        "google_accounts",
        "reportsFolderId",
        `VARCHAR(255)`
    );


    console.log(
        "✅ Schéma Trackzo finalisé"
    );
}


module.exports = {
    finalizeTrackzoSchema
};