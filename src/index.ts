import notify from "./notify";

interface ZiplineFile {
    id: number, // 529
    name: string, // "jO2DMR.png"
    originalName?: string, // "balls.png"
    url?: string, // "/u/jO2DMR.png"
    mimetype: string, // "image/png"
    createdAt: string, // "2022-12-01T17:41:48.887Z"
    size: number,
    expiresAt?: string,
    maxViews?: number,
    views: number,
    favorite: boolean,
    embed: boolean,
    password?: string,
    userId: number,
    folderId?: number,
    user?: {
        administrator: boolean,
        superAdmin: boolean,
        username: string,
        id: number,
    },
    thumbnail?: unknown,
}

interface ZiplineDeleteAllResponse {
    count?: number,
}

type ZiplineDeleteFilesResponse = ZiplineFile | ZiplineDeleteAllResponse;

interface CfCachePurgeResponse {
    errors: any[],
    messages: any[],
    success: boolean,
    result: {
        id: string, // "023e105f4ecef8ad9ca31a8372d0c353"
    },
}

async function findZiplineFileByName(fileName: string, ziplineToken: string, env: Env) {
    const recentFilesResponse = await fetch(
        `${env.ZIPLINE_URL_BASE}/api/user/recent?take=50`, {
            headers: {
                "Content-Type": "application/json",
                "Authorization": ziplineToken,
            },
        });

    if (recentFilesResponse.status !== 200) {
        console.error("Failed to get recent files", recentFilesResponse);
        return null;
    }

    const recentFiles = (await recentFilesResponse.json()) as ZiplineFile[];

    const foundFile = recentFiles.find(file => file.name === fileName);

    return foundFile || null;
}

async function deleteZiplineFileById(fileId: number, ziplineToken: string, env: Env) {
    const deleteFileResponse = await fetch(
        `${env.ZIPLINE_URL_BASE}/api/user/files`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "Authorization": ziplineToken,
            },
            body: JSON.stringify({ id: fileId }),
        });

    const file = (await deleteFileResponse.json()) as ZiplineFile | null;

    return {
        response: deleteFileResponse,
        file
    };
}

async function purgeZiplineFile(file: ZiplineFile, env: Env) {
    // const urlToPurge = `https://${requestUrl.hostname}/${file.url}`;
    const urlToPurge = `${env.ZIPLINE_URL_BASE}/${file.name}`;
    console.debug(`Trying to purge URL '${urlToPurge}'`);

    const purgeResponse = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${env.ZONE_ID}/purge_cache`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${env.CF_API_KEY}`,
            },
            body: JSON.stringify({ files: [urlToPurge] }),
        });
    const purgeResult = (await purgeResponse.json()) as CfCachePurgeResponse;

    if (!purgeResult.success) {
        console.error(`Failed to purge URL '${urlToPurge}'`);
        await notify.telegramNotify("warning", "👎 Failed to purge CF cache \\- Zipline file deletion",
            `Affected url: ${notify.telegramSanitize(urlToPurge)}\nID: \`${file.id}\`\nName: \`${file.name}\`\nViews: ${file.views}`,
            env.TG_NOTIFY_CONTACT_ID, env.TG_BOT_TOKEN
        );
    } else {
        await notify.telegramNotify("note", "✅ Purged CF cache \\- Zipline file deletion",
            `Affected url: ${notify.telegramSanitize(urlToPurge)}\nID: \`${file.id}\`\nName: \`${file.name}\`\nViews: ${file.views}`,
            env.TG_NOTIFY_CONTACT_ID, env.TG_BOT_TOKEN
        );
    }

    return purgeResult.success;
}

function responseWithPurgeHeader(response: global.Response, purgeOutcome: boolean | null) {
    const newResponse = new Response(response.body, response);
    if (purgeOutcome === null)
        return newResponse;
    newResponse.headers.append("X-Cache-Purge-Result", purgeOutcome ? "ok" : "fail");
    return newResponse;
}

export default {
    async fetch(request, env, ctx): Promise<Response> {
        const url = new URL(request.url);

        // Ignore non-delete requests
        if (request.method !== "DELETE")
            return fetch(request);

        const ziplineToken = request.headers.get("Authorization");

        // Try to see if it's the custom addition to the API, not present in Zipline
        // `DELETE /api/user/files/id/:id` - Delete file by id
        const fileIdMatch = url.pathname.match("/api/user/files/id/([1-9][0-9]*)");
        if (fileIdMatch && ziplineToken) {
            const fileId = parseInt(fileIdMatch[0]);
            const { response, file } = await deleteZiplineFileById(fileId, ziplineToken, env);
            const purgeOutcome = file ? await purgeZiplineFile(file, env) : null;
            return responseWithPurgeHeader(response, purgeOutcome);
        }

        // `DELETE /api/user/files/name/:name` - Delete file by name
        const fileNameMatch = url.pathname.match("/api/user/files/name/([^/?]+)");
        if (fileNameMatch && ziplineToken) {
            const fileName = fileNameMatch[0];
            const foundFile = await findZiplineFileByName(fileName, ziplineToken, env);
            if (!foundFile)
                return new Response('{"error":"File not found in recent files"}', { status: 404 });
            const { response, file } = await deleteZiplineFileById(foundFile.id, ziplineToken, env);
            const purgeOutcome = file ? await purgeZiplineFile(file, env) : null;
            return responseWithPurgeHeader(response, purgeOutcome);
        }

        // If it's not custom API - relay it
        const response = await fetch(request);

        // IF deletion is not successfull - just relay the response
        if (!(url.pathname === "/api/user/files") && (response.status === 200))
            return responseWithPurgeHeader(response, null);

        const data = (await response.clone().json()) as ZiplineDeleteFilesResponse | null;
        if (!data)
            return responseWithPurgeHeader(response, null);
        
        // Single file deletion
        if ("id" in data)
            return responseWithPurgeHeader(response, await purgeZiplineFile(data, env));

        // Deleting all files
        if ("count" in data) {
            console.error("Bulk deletion in Zipline, unable to purge cache. Please purge manually!");
            await notify.telegramNotify("warning", "Unable to purge CF cache for Zipline bulk deletion",
                `Affected file count: \`${data.count}\`\nThis is not implemented. Please purge the cache manually.`,
                env.TG_NOTIFY_CONTACT_ID, env.TG_BOT_TOKEN
            );
        }

        // None of the above response - outside of API spec
        if (!("id" in data) && !("count" in data)) {
            console.error("Zipline response doesn't make sense for some reason...", data);
        }

        return responseWithPurgeHeader(response, false);
    },
} satisfies ExportedHandler<Env>;
