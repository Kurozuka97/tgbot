import { Bot } from "grammy";

const LOSSLESS_EXT  = new Set(["flac","wav","aiff","aif","alac","ape","wv","tak","tta"]);
const LOSSY_EXT     = new Set(["mp3","aac","ogg","opus","m4a","wma"]);
const LOSSLESS_MIME = new Set([
  "audio/flac","audio/x-flac",
  "audio/wav","audio/x-wav",
  "audio/aiff","audio/x-aiff",
]);

const FORMAT_TAG: Record<string, string> = {
  wav:  "#WAV #Lossless",
  aiff: "#AIFF #Lossless",
  aif:  "#AIFF #Lossless",
  alac: "#ALAC #Lossless",
  ape:  "#APE #Lossless",
  wv:   "#WavPack #Lossless",
  tak:  "#TAK #Lossless",
  tta:  "#TTA #Lossless",
};

// Handles #FLAC, #FLAC16, #FLAC24, kbps tags, etc.
const QUALITY_TAG_RE = /#(lossless|lossy|flac\d*|wav|aiff|alac|ape|wavpack|tak|tta|mp3|aac|ogg|opus|m4a|wma|\d+kbps?)\b/gi;

// Reads only the first 64 bytes of a FLAC file and parses STREAMINFO
// to extract bit depth. FLAC header + STREAMINFO fits in ~48 bytes.
//
// FLAC file layout:
//   [0-3]  "fLaC" magic
//   [4]    metadata block header byte (bit7=last, bits6-0=type; 0=STREAMINFO)
//   [5-7]  block length (24-bit big-endian, always 34 for STREAMINFO)
//   [8-41] STREAMINFO data (34 bytes):
//            [8-9]   min block size
//            [10-11] max block size
//            [12-14] min frame size
//            [15-17] max frame size
//            [18-25] packed: sample_rate(20b) | channels-1(3b) | bps-1(5b) | total_samples(36b)
//
// bps-1 occupies: bit0 of byte[20] (MSB) + bits7-4 of byte[21]
async function fetchFlacBitDepth(fileId: string): Promise<number | null> {
  try {
    const token = process.env.BOT_TOKEN;
    if (!token) return null;

    const infoRes = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`
    );
    const info = await infoRes.json() as {
      ok: boolean;
      result?: { file_path?: string };
    };
    if (!info.ok || !info.result?.file_path) return null;

    const fileUrl = `https://api.telegram.org/file/bot${token}/${info.result.file_path}`;

    const fileRes = await fetch(fileUrl, { headers: { Range: "bytes=0-63" } });
    const reader  = fileRes.body!.getReader();
    const { value: b } = await reader.read();
    await reader.cancel();

    if (!b || b.length < 22) return null;

    // "fLaC" magic
    if (b[0] !== 0x66 || b[1] !== 0x4C || b[2] !== 0x61 || b[3] !== 0x43) return null;

    // First metadata block must be STREAMINFO (type 0)
    if ((b[4] & 0x7F) !== 0) return null;

    const bpsMinusOne = ((b[20] & 0x01) << 4) | ((b[21] >> 4) & 0x0F);
    return bpsMinusOne + 1;
  } catch {
    return null;
  }
}

function buildFlacTag(bps: number | null): string {
  if (bps === 16) return "#FLAC16 #Lossless";
  if (bps === 24) return "#FLAC24 #Lossless";
  if (bps != null) return `#FLAC${bps} #Lossless`; // 32-bit etc.
  return "#FLAC #Lossless";                          // fallback (>20MB or parse fail)
}

async function resolveQuality(
  mimeType: string | undefined,
  fileName: string | undefined,
  fileId: string,
): Promise<{ lossless: boolean | null; tag: string }> {
  const ext  = fileName?.split(".").pop()?.toLowerCase();
  const mime = mimeType?.toLowerCase();

  if ((ext && LOSSLESS_EXT.has(ext)) || (mime && LOSSLESS_MIME.has(mime))) {
    if (ext === "flac" || mime === "audio/flac" || mime === "audio/x-flac") {
      const bps = await fetchFlacBitDepth(fileId);
      return { lossless: true, tag: buildFlacTag(bps) };
    }
    return { lossless: true, tag: (ext && FORMAT_TAG[ext]) || "#Lossless" };
  }

  if (ext && LOSSY_EXT.has(ext)) {
    return { lossless: false, tag: "#Lossy" };
  }

  return { lossless: null, tag: "" };
}

function patchCaption(caption: string | undefined, tag: string): string {
  const stripped = (caption ?? "")
    .replace(QUALITY_TAG_RE, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped ? `${stripped}\n\n${tag}` : tag;
}

export function registerLosslessHandler(bot: Bot): void {
  bot.on("channel_post", async (ctx) => {
    const msg   = ctx.channelPost;
    const media = msg.audio ?? msg.document;
    if (!media) return;

    const mimeType = "mime_type" in media ? media.mime_type : undefined;
    const fileName = "file_name" in media ? media.file_name : undefined;
    const fileId   = media.file_id;

    const { lossless, tag } = await resolveQuality(mimeType, fileName, fileId);
    if (lossless === null) return;

    const newCaption = patchCaption(msg.caption, tag);
    if (newCaption === (msg.caption ?? "")) return;

    try {
      await ctx.api.editMessageCaption(msg.chat.id, msg.message_id, {
        caption: newCaption,
      });
    } catch (e) {
      console.error(`[lossless] edit failed for msg ${msg.message_id}:`, e);
    }
  });
}
