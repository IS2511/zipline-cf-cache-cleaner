import notify from "./notify";

// Based on the Zipline v3 Prisma schema
// https://github.com/diced/zipline/blob/920c996892dac634f248ab4bd86e1dcd5788e037/prisma/schema.prisma#L59
interface ZiplineV3File {
    id: number; // 529
    name: string; // "jO2DMR.png"
    originalName?: string; // "balls.png"
    // This one is weird, only mentioned in docs, not in model
    // https://v3.zipline.diced.sh/docs/api/models/file
    url?: string; // "/u/jO2DMR.png"
    mimetype: string; // "image/png"
    createdAt: string; // "2022-12-01T17:41:48.887Z"
    size: bigint;
    expiresAt?: string;
    maxViews?: number;
    views: number;
    favorite: boolean;
    embed: boolean;

    user?: {
        id: number;
        uuid: string;
        username: string;
        avatar?: string;
        administrator: boolean;
        superAdmin: boolean;
    };

    folder?: {
        id: number;
        name: string;
        public: boolean;
    };

    thumbnail?: {
        id: number;
        name: string;
    };
}

// Based on the Zipline v4 Prisma schema
// https://github.com/diced/zipline/blob/ef0580655d9134b21ad111ef38a281c381fb53ed/prisma/schema.prisma#L241
interface ZiplineV4File {
    id: string;
    createdAt: string;
    updatedAt: string;
    deletesAt?: string;

    name: string;
    originalName?: string;
    size: bigint;
    type: string;
    views: number;
    maxViews?: number;
    favorite: boolean;
    password?: string;

    tags: {
        id: string;
        name: string;
        color: string;
    }[];

    user?: {
        id: string;
        username: string;
        avatar?: string;
        // cspell:disable-next-line (Disable spellcheck for next line)
        role: "USER" | "ADMIN" | "SUPERADMIN";
    };

    folder?: {
        id: string;
        name: string;
        public: boolean;
        allowUploads: boolean;
    };

    thumbnail?: {
        id: string;
        path: string;
    };
}

interface ZiplineV3VersionResponse {
    isUpstream: boolean;
    update: boolean;
    updateToType: string;

    versions: {
        stable: string;
        upstream: string;
        current: string;
    };
}

interface ZiplineV4VersionResponse {
    version: string;
}

interface ZiplineV3DeleteAllFilesResponse {
    count?: number,
}

type ZiplineV3DeleteFileResponse = ZiplineV3File;
type ZiplineV3AnyFileDeletionResponse = ZiplineV3File | ZiplineV3DeleteAllFilesResponse;

type ZiplineV4DeleteFileResponse = ZiplineV4File;

interface CfCachePurgeResponse {
    errors: any[],
    messages: any[],
    success: boolean,
    result: {
        id: string, // "023e105f4ecef8ad9ca31a8372d0c353"
    },
}

async function findZiplineV3FileByName(fileName: string, ziplineToken: string, env: Env) {
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

    const recentFiles = (await recentFilesResponse.json()) as ZiplineV3File[];

    const foundFile = recentFiles.find(file => file.name === fileName);

    return foundFile || null;
}

async function deleteZiplineV3FileById(fileId: number, ziplineToken: string, env: Env) {
    const deleteFileResponse = await fetch(
        `${env.ZIPLINE_URL_BASE}/api/user/files`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "Authorization": ziplineToken,
            },
            body: JSON.stringify({ id: fileId }),
        });

    const file = (await deleteFileResponse.json()) as ZiplineV3File | null;

    return {
        response: deleteFileResponse,
        file
    };
}

async function purgeZiplineFileFromCloudflare(file: ZiplineV3File | ZiplineV4File, env: Env) {
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
        // Ignore (forward unchanged) all non-delete requests
        if (request.method !== "DELETE")
            return fetch(request);

        const url = new URL(request.url);
        const ziplineToken = request.headers.get("Authorization");

        // Try to see if it's the custom addition to the API, not present in Zipline
        // `DELETE /api/user/files/id/:id` - Delete file by id
        const fileIdMatch = url.pathname.match("/api/user/files/id/([1-9][0-9]*)");
        if (fileIdMatch && ziplineToken) {
            const fileId = parseInt(fileIdMatch[0]);
            const { response, file } = await deleteZiplineV3FileById(fileId, ziplineToken, env);
            const purgeOutcome = file ? await purgeZiplineFileFromCloudflare(file, env) : null;
            return responseWithPurgeHeader(response, purgeOutcome);
        }

        // `DELETE /api/user/files/name/:name` - Delete file by name
        const fileNameMatch = url.pathname.match("/api/user/files/name/([^/?]+)");
        if (fileNameMatch && ziplineToken) {
            const fileName = fileNameMatch[0];
            const foundFile = await findZiplineV3FileByName(fileName, ziplineToken, env);
            if (!foundFile)
                return new Response('{"error":"File not found in recent files"}', { status: 404 });
            const { response, file } = await deleteZiplineV3FileById(foundFile.id, ziplineToken, env);
            const purgeOutcome = file ? await purgeZiplineFileFromCloudflare(file, env) : null;
            return responseWithPurgeHeader(response, purgeOutcome);
        }

        // If it's not custom API - relay it
        const response = await fetch(request);

        // Let's see if it's a Zipline v3 or v4 based on the response
        // Only v4 has the `tags` field, so we can use that to determine the version
        // And only v3 has the `embed` field in the response
        let isZiplineV4 = false;
        if (response.headers.get("Content-Type")?.includes("application/json")) {
            const data = await response.clone().json() as any;
            if (data && "embed" in data) {
                isZiplineV4 = false;
            }
            if (data && "tags" in data) {
                isZiplineV4 = true;
            }
        }

        if (isZiplineV4) {
            // Zipline v4

            // If deletion is not successful or it wasn't deletion - just relay the response
            if (!(url.pathname.startsWith("/api/user/files/") && (response.status === 200)))
                return responseWithPurgeHeader(response, null);

            const data = (await response.clone().json()) as ZiplineV4DeleteFileResponse | null;
            if (!data)
                return responseWithPurgeHeader(response, null);

            // Single file deletion
            if ("id" in data)
                return responseWithPurgeHeader(response, await purgeZiplineFileFromCloudflare(data, env));

            // Unknown response - outside of API spec
            if (!("id" in data)) {
                console.error("Zipline v4 response doesn't make sense for some reason...", data);
            }
        } else {
            // Zipline v3

            // If deletion is not successful or it wasn't deletion - just relay the response
            if (!((url.pathname === "/api/user/files") && (response.status === 200)))
                return responseWithPurgeHeader(response, null);

            const data = (await response.clone().json()) as ZiplineV3DeleteFileResponse | null;
            if (!data)
                return responseWithPurgeHeader(response, null);

            // Single file deletion
            if ("id" in data)
                return responseWithPurgeHeader(response, await purgeZiplineFileFromCloudflare(data, env));

            // Deleting all files
            if ("count" in data) {
                console.error("Bulk deletion in Zipline v3, unable to purge cache. Please purge manually!");
                await notify.telegramNotify("warning", "Unable to purge CF cache for Zipline bulk deletion",
                    `Affected file count: \`${data.count}\`\nThis is not implemented. Please purge the cache manually.`,
                    env.TG_NOTIFY_CONTACT_ID, env.TG_BOT_TOKEN
                );
            }

            // None of the above response - outside of API spec
            if (!("id" in data) && !("count" in data)) {
                console.error("Zipline v3 response doesn't make sense for some reason...", data);
            }
        }

        return responseWithPurgeHeader(response, false);
    },
} satisfies ExportedHandler<Env>;
