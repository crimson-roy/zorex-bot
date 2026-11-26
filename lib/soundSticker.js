'use strict';

// WhatsApp sound stickers: an animated sticker with a separately uploaded
// Ogg/Opus track. Baileys 7.0.0-rc14 does not know these two protobuf fields:
//
//   Message.audioStickerMessage   field 134  (FutureProofMessage)
//   StickerMessage.audioMessage   field 26   (AudioMessage)
//
// Instead of editing node_modules, we wrap Baileys' encoders at runtime and
// append the missing field. Protobuf allows fields in any order. The format is
// unofficial (as observed by the community), so a WhatsApp update can break it.

const PATCHED = Symbol.for('zorex.soundSticker.patched');

// Tag = (fieldNumber << 3) | 2 (length-delimited).
const TAG_MESSAGE_AUDIO_STICKER = (134 << 3) | 2;
const TAG_STICKER_AUDIO = (26 << 3) | 2;

function appendField(Type, property, tag, getCodec) {
    const original = Type.encode;

    Type.encode = function encodeWithSoundSticker(message, writer) {
        const out = original.call(this, message, writer);
        const value = message?.[property];

        if (value) {
            getCodec().encode(value, out.uint32(tag).fork()).ldelim();
        }

        return out;
    };
}

function patchProto(proto) {
    if (proto.Message[PATCHED]) return;

    appendField(
        proto.Message,
        'audioStickerMessage',
        TAG_MESSAGE_AUDIO_STICKER,
        () => proto.Message.FutureProofMessage
    );

    appendField(
        proto.Message.StickerMessage,
        'audioMessage',
        TAG_STICKER_AUDIO,
        () => proto.Message.AudioMessage
    );

    proto.Message[PATCHED] = true;
}

async function sendSoundSticker(sock, chatId, { webp, opus, seconds, size }) {
    const {
        proto,
        prepareWAMessageMedia,
        generateWAMessageFromContent
    } = await import('@whiskeysockets/baileys');

    patchProto(proto);

    const upload = { upload: sock.waUploadToServer };

    const { stickerMessage } =
        await prepareWAMessageMedia({ sticker: webp }, upload);

    const { audioMessage } =
        await prepareWAMessageMedia(
            {
                audio: opus,
                mimetype: 'audio/ogg; codecs=opus',
                seconds
            },
            upload
        );

    stickerMessage.isAnimated = true;
    stickerMessage.width = size;
    stickerMessage.height = size;
    stickerMessage.audioMessage = audioMessage;

    const waMessage = generateWAMessageFromContent(
        chatId,
        { audioStickerMessage: { message: { stickerMessage } } },
        { userJid: sock.user.id }
    );

    await sock.relayMessage(chatId, waMessage.message, {
        messageId: waMessage.key.id
    });

    return waMessage;
}

module.exports = { patchProto, sendSoundSticker };
