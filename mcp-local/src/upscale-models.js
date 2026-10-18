// Local-edition model registry: the 4 remote models (imported live from
// server/src/upscale/models.js) PLUS the 6 large ones that only run locally.
// Weight URLs copied from isixe/bg2x src/config/models.ts (see NOTICE-bg2x.md).
// MIT License — vendored from isixe/bg2x. Copyright (c) isixe.
import { MODELS as REMOTE_MODELS } from '../../server/src/upscale/models.js';

const HF = 'https://huggingface.co';
const ML = 'https://www.modelscope.cn/models';

export const LOCAL_EXTRA_MODELS = [
  {
    id: 'x4plus',
    name: 'Real-ESRGAN x4plus',
    url: `${HF}/SceneWorks/real-esrgan-onnx/resolve/main/real_esrgan_x4.onnx`,
    fallbackUrls: [
      `${ML}/starwhisper9/Real-ESRGAN-onnx/resolve/master/RealESRGAN_x4plus.onnx?view=false`,
    ],
    scale: 4,
    sizeMB: 67,
  },
  {
    id: 'swin-classical-x4',
    name: 'Swin2SR Classical x4',
    url: `${HF}/Xenova/swin2SR-classical-sr-x4-64/resolve/main/onnx/model.onnx`,
    fallbackUrls: [
      `${ML}/Xenova/swin2SR-classical-sr-x4-64/resolve/master/onnx/model.onnx?view=false`,
    ],
    scale: 4,
    sizeMB: 55,
  },
  {
    id: 'swin-realworld-x4',
    name: 'Swin2SR RealWorld x4',
    url: `${HF}/Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr/resolve/main/onnx/model.onnx`,
    fallbackUrls: [
      `${ML}/Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr/resolve/master/onnx/model.onnx?view=false`,
    ],
    scale: 4,
    sizeMB: 53,
  },
  {
    id: 'swin-compressed-x4',
    name: 'Swin2SR Compressed x4',
    url: `${HF}/Xenova/swin2SR-compressed-sr-x4-48/resolve/main/onnx/model.onnx`,
    fallbackUrls: [
      `${ML}/Xenova/swin2SR-compressed-sr-x4-48/resolve/master/onnx/model.onnx?view=false`,
    ],
    scale: 4,
    sizeMB: 55,
  },
  {
    id: 'x4plus-anime',
    name: 'Real-ESRGAN x4plus Anime',
    url: `${HF}/deepghs/imgutils-models/resolve/main/real_esrgan/RealESRGAN_x4plus_anime_6B.onnx`,
    fallbackUrls: [
      `${ML}/Rokaa111/RealESRGAN_x4plus_anime_6B/resolve/master/RealESRGAN_x4plus_anime_6B.onnx?view=false`,
    ],
    scale: 4,
    sizeMB: 18,
  },
  {
    id: 'x4plus-anime-4b32f',
    name: 'Real-ESRGAN x4plus Anime 4B32F',
    url: `${HF}/deepghs/imgutils-models/resolve/main/real_esrgan/RealESRGAN_x4plus_anime_4B32F.onnx`,
    fallbackUrls: [
      `${ML}/Rokaa111/real-esrgan-x4plus-anime-4b32f/resolve/master/RealESRGAN_x4plus_anime_4B32F.onnx?view=false`,
    ],
    scale: 4,
    sizeMB: 5.2,
  },
];

export const LOCAL_MODELS = [...REMOTE_MODELS, ...LOCAL_EXTRA_MODELS];

export function findLocalModel(id) {
  return LOCAL_MODELS.find((m) => m.id === id);
}
