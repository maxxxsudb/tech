(function (factory) {
  if (typeof define === "function") define([], factory);
  else if (typeof module === "object" && module.exports) module.exports = factory();
})(function () {
  "use strict";

  const limits = Object.freeze({
    maxFiles: 4,
    maxImageBytes: 10 * 1024 * 1024,
    maxTextBytes: 1024 * 1024,
    maxEncodedImageBytes: 2 * 1024 * 1024,
    maxWidth: 1600,
    maxHeight: 1200,
  });
  let nextId = 0;

  function kindOf(file) {
    const name = String(file.name || "");
    const mime = String(file.type || "").toLowerCase();
    if (/\.(png|jpe?g)$/i.test(name) || /^(image\/png|image\/jpeg)$/.test(mime)) return "image";
    if (/\.(log|txt|json|md)$/i.test(name)) return "text";
    throw new Error("Поддерживаются PNG, JPEG, .log, .txt, .json и .md.");
  }

  function readFile(file, asDataUrl) {
    if (!asDataUrl && typeof file.text === "function") return Promise.resolve().then(() => file.text());
    return new Promise((resolve, reject) => {
      if (typeof FileReader === "undefined") {
        reject(new Error("Браузер не поддерживает чтение вложений."));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Не удалось прочитать файл «" + file.name + "»."));
      reader.onabort = () => reject(new Error("Чтение файла отменено."));
      if (asDataUrl) reader.readAsDataURL(file);
      else reader.readAsText(file, "UTF-8");
    });
  }

  function dataUrlBytes(dataUrl) {
    const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  }

  function prepareImage(dataUrl) {
    return new Promise((resolve, reject) => {
      if (typeof Image === "undefined" || typeof document === "undefined") {
        reject(new Error("Браузер не поддерживает обработку изображений."));
        return;
      }
      const image = new Image();
      image.onerror = () => reject(new Error("Не удалось открыть изображение. Выберите PNG или JPEG."));
      image.onload = () => {
        try {
          const sourceWidth = image.naturalWidth || image.width;
          const sourceHeight = image.naturalHeight || image.height;
          if (!sourceWidth || !sourceHeight) throw new Error("Изображение имеет пустой размер.");
          const scale = Math.min(1, limits.maxWidth / sourceWidth, limits.maxHeight / sourceHeight);
          const canvas = document.createElement("canvas");
          let width = Math.max(1, Math.round(sourceWidth * scale));
          let height = Math.max(1, Math.round(sourceHeight * scale));
          let quality = 0.85;
          for (let attempt = 0; attempt < 16; attempt++) {
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Не удалось обработать изображение.");
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, width, height);
            context.drawImage(image, 0, 0, width, height);
            const encoded = canvas.toDataURL("image/jpeg", quality);
            if (!encoded.startsWith("data:image/jpeg;base64,")) throw new Error("Не удалось преобразовать изображение в JPEG.");
            const bytes = dataUrlBytes(encoded);
            if (bytes <= limits.maxEncodedImageBytes) {
              resolve({ dataUrl: encoded, width, height, bytes, mime: "image/jpeg" });
              return;
            }
            if (quality > 0.45) quality = Math.max(0.45, quality - 0.15);
            else {
              width = Math.max(1, Math.round(width * 0.8));
              height = Math.max(1, Math.round(height * 0.8));
            }
          }
          throw new Error("Изображение слишком большое. Уменьшите его и добавьте заново.");
        } catch (reason) {
          reject(reason);
        }
      };
      image.src = dataUrl;
    });
  }

  async function readAttachment(file) {
    if (!file) throw new Error("Файл не выбран.");
    const kind = kindOf(file);
    const maximum = kind === "image" ? limits.maxImageBytes : limits.maxTextBytes;
    if (!Number.isFinite(file.size) || file.size < 0) throw new Error("Не удалось определить размер файла.");
    if (file.size > maximum) {
      throw new Error("Файл «" + file.name + "» превышает " + (kind === "image" ? "10" : "1") + " МБ.");
    }
    const attachment = {
      id: "attachment-" + Date.now().toString(36) + "-" + (++nextId),
      name: String(file.name || (kind === "image" ? "image.jpg" : "attachment.txt")),
      kind,
      mime: kind === "text" ? String(file.type || "text/plain") : "image/jpeg",
      bytes: file.size,
      originalBytes: file.size,
    };
    if (kind === "text") attachment.content = await readFile(file, false);
    else Object.assign(attachment, await prepareImage(await readFile(file, true)));
    return attachment;
  }

  function composeText(attachments) {
    return (attachments || []).filter((item) => item.kind === "text").map((item) => {
      const content = String(item.content || "");
      const runs = content.match(/`+/g) || [];
      const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
      return "### Вложение: " + String(item.name || "attachment.txt").replace(/[\r\n]/g, " ") + "\n" + fence + "text\n" + content + "\n" + fence;
    }).join("\n\n");
  }

  function summaries(attachments) {
    return (attachments || []).map((item) => {
      const result = {};
      ["id", "name", "kind", "mime", "bytes", "originalBytes", "width", "height"].forEach((key) => {
        if (item[key] !== undefined) result[key] = item[key];
      });
      return result;
    });
  }

  function buildUserMessage(prompt, images, transport, imageUserMessage) {
    const attachedImages = (images || []).filter((item) => item && item.dataUrl);
    if (!attachedImages.length) return { role: "user", content: prompt };
    const messages = attachedImages.map((item) => {
      const message = imageUserMessage(prompt, item, transport);
      if (Array.isArray(message.content)) {
        message.content.forEach((part) => {
          if (part.type === "file" && part.file) part.file.filename = item.name || part.file.filename;
        });
      }
      return message;
    });
    if (transport === "ollamaImages") {
      return { role: "user", content: prompt, images: messages.flatMap((message) => message.images || []) };
    }
    return {
      role: "user",
      content: [{ type: "text", text: prompt }].concat(messages.flatMap((message) => (message.content || []).filter((part) => part.type !== "text"))),
    };
  }

  return { limits, readAttachment, composeText, summaries, buildUserMessage };
});
