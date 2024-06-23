type Severity = 5 | 4 | 3 | 2 | 1 | "note" | "info" | "warning" | "serious" | "critical";

function severityToEmoji(severity: Severity) {
    switch (severity) {
        case 5:
        case "note":
            return "📄";
        case 4:
        case "info":
            return "ℹ️";
        case 3:
        case "warning":
            return "⚠️";
        case 2:
        case "serious":
            return "🚨";
        case 1:
        case "critical":
            return "🆘";
        default:
            return "❔"
    }
}

function severityToPretty(severity: Severity) {
    const toText = (s: Severity) => {
            switch (s) {
            case 5:
            case "note":
                return "Note";
            case 4:
            case "info":
                return "Info";
            case 3:
            case "warning":
                return "Warning";
            case 2:
            case "serious":
                return "Serious";
            case 1:
            case "critical":
                return "Critical";
            default:
                return "Not specified"
        }
    }
    return `${severityToEmoji(severity)} ${toText(severity)}`;
}

export default {
    telegramSanitize(input: string) {
        const charsNeedEscape = ['\\', '_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
        for (const char of charsNeedEscape) {
            input = input.replaceAll(char, `\\${char}`);
        }
        return input;
    },

    async telegramNotify(severity: Severity, subject: string, details: string, contactUserId: number | string, botToken: string) {
        const body = JSON.stringify({
            chat_id: contactUserId,
            parse_mode: "MarkdownV2",
            text: `\\[S: ${severityToEmoji(severity)}\\] ${subject}\n\nSeverity: ${severityToPretty(severity)}\nSource: \`zipline-cf-cache-cleaner\`\n\n${details}`,
            disable_notification: ((severity === "note") || (severity === 5)), 
        });
        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body,
        });

        if (response.status !== 200) {
            console.error(`Failed to send Telegram message: ${response.status} ${response.statusText}.`, await response.clone().text(), body);
        }

        return response;
    }
}
