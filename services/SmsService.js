const UserSettings = require("../models/UserSettings");
const DailySheet = require("../models/DailySheet");
const GoogleAccount = require("../models/GoogleAccount");
const SmsReceipt = require("../models/SmsReceipt");
const { getLocalDate, createDailySheet } = require("./dailySheetService");
const { appendRawRows, rawHashExists } = require("./dailySheetWriter");
const { processDailySheet } = require("./dailySheetProcessorService");

const PROCESSING_STALE_MS = 5 * 60 * 1000;
const processingTimers = new Map();

function scheduleProcessing(refreshToken, spreadsheetId) {
    const previous = processingTimers.get(spreadsheetId);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(async () => {
        processingTimers.delete(spreadsheetId);
        try {
            const result = await processDailySheet(refreshToken, spreadsheetId);
            console.log("⚙️ Traitement feuille automatique terminé:", {
                spreadsheetId, processed: result.processed, cleaned: result.cleaned,
                alerts: result.alerts, errors: result.errors
            });
        } catch (error) {
            console.error("⚠️ Traitement feuille différé:", error.message);
        }
    }, 2000);

    processingTimers.set(spreadsheetId, timer);
}

async function send({ userId, sender, message, receivedAt, smsHash }) {
    const normalizedSender = String(sender ?? "").trim();
    const normalizedMessage = String(message ?? "").trim();
    const normalizedHash = String(smsHash ?? "").trim();
    if (!userId || !normalizedSender || !normalizedMessage || !normalizedHash) {
        throw new Error("Données SMS incomplètes");
    }

    let receipt = await SmsReceipt.findOne({ where: { smsHash: normalizedHash } });
    if (receipt?.status === "COMPLETED") return { duplicate: true };

    const settings = await UserSettings.findOne({ where: { userId } });
    if (!settings) throw new Error("Paramètres utilisateur introuvables");
    const googleAccount = await GoogleAccount.findOne({ where: { userId } });
    if (!googleAccount?.refreshToken) throw new Error("Compte Google non connecté");

    const timezone = settings.timezone || "Africa/Abidjan";
    const date = getLocalDate(timezone);
    let dailySheet = await DailySheet.findOne({ where: { userId, date } });
    if (!dailySheet) dailySheet = await createDailySheet(userId);

    // Un retry après timeout doit d'abord vérifier si Google avait déjà accepté
    // l'append. Le hash technique en colonne E rend cette vérification idempotente.
    if (receipt?.status === "PROCESSING") {
        const alreadyInSheet = await rawHashExists(
            googleAccount.refreshToken, dailySheet.spreadsheetId, normalizedHash
        );
        if (alreadyInSheet) {
            await receipt.update({ status: "COMPLETED" });
            scheduleProcessing(googleAccount.refreshToken, dailySheet.spreadsheetId);
            return { duplicate: true, reconciled: true, spreadsheetId: dailySheet.spreadsheetId };
        }

        const updatedAt = receipt.updatedAt ? new Date(receipt.updatedAt).getTime() : 0;
        if (Date.now() - updatedAt < PROCESSING_STALE_MS) {
            return { processing: true };
        }
        console.warn("⚠️ Receipt PROCESSING ancien, reprise autorisée", normalizedHash);
    }

    if (!receipt) {
        try {
            receipt = await SmsReceipt.create({
                userId, smsHash: normalizedHash, sender: normalizedSender,
                message: normalizedMessage, receivedAt, status: "PROCESSING"
            });
        } catch (error) {
            if (error.name === "SequelizeUniqueConstraintError") {
                receipt = await SmsReceipt.findOne({ where: { smsHash: normalizedHash } });
                if (receipt?.status === "COMPLETED") return { duplicate: true };
                return { processing: true };
            }
            throw error;
        }
    } else if (receipt.status !== "PROCESSING") {
        await receipt.update({ status: "PROCESSING" });
    }

    const timestamp = Number(receivedAt);
    const safeDate = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp) : new Date();
    const time = new Intl.DateTimeFormat("fr-FR", {
        timeZone: timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(safeDate);

    // A:D restent compatibles avec le modèle actuel. E stocke le hash uniquement
    // pour l'idempotence technique et n'est pas utilisé par le processor.
    await appendRawRows(
        googleAccount.refreshToken,
        dailySheet.spreadsheetId,
        [[date, time, normalizedMessage, "PENDING", normalizedHash]]
    );

    // ACK serveur : à partir de cet instant, le SMS peut sortir de Room.
    await receipt.update({ status: "COMPLETED" });

    // Traitement regroupé par feuille : plusieurs SMS rapprochés déclenchent une
    // seule exécution après 2 secondes, au lieu d'une exécution Google par SMS.
    scheduleProcessing(googleAccount.refreshToken, dailySheet.spreadsheetId);

    return {
        duplicate: false,
        accepted: true,
        spreadsheetId: dailySheet.spreadsheetId
    };
}

module.exports = { send };
