// Model registry (whitelist). 4 remote models; ids are the short labels used
// by the spec/plan. URLs copied from isixe/bg2x src/config/models.ts.
export const MODELS = [
  {
    id: 'general-x4v3',
    name: 'Real-ESRGAN General x4v3',
    url: 'https://huggingface.co/Heliosoph/realesrgan-onnx/resolve/main/realesr-general-x4v3.onnx',
    fallbackUrls: ['https://www.modelscope.cn/models/ctan0ctan0/realesrgan-onnx/resolve/master/realesr-general-x4v3.onnx?view=false'],
    scale: 4,
    sizeMB: 4.9,
  },
  {
    id: 'anime-v3',
    name: 'Real-ESRGAN AnimeVideo v3',
    url: 'https://huggingface.co/skillsafe-ai/realesr-animevideov3/resolve/main/model.onnx',
    fallbackUrls: ['https://www.modelscope.cn/models/Rokaa111/real-esrgan-animevideov3/resolve/master/model.onnx?view=false'],
    scale: 4,
    sizeMB: 2.5,
  },
  {
    id: 'cugan-2x',
    name: 'Real-CUGAN 2x (HFA2k)',
    url: 'https://huggingface.co/nesaorg/2xHFA2kReal-CUGAN_fp32_opset17/resolve/main/2xHFA2kReal-CUGAN_fp32_opset17.onnx',
    fallbackUrls: ['https://www.modelscope.cn/models/nesaorg/2xHFA2kReal-CUGAN_fp32_opset17/resolve/master/2xHFA2kReal-CUGAN_fp32_opset17.onnx?view=false'],
    scale: 2,
    sizeMB: 5.2,
  },
  {
    id: 'swin-light-x2',
    name: 'Swin2SR Lightweight x2',
    url: 'https://huggingface.co/Xenova/swin2SR-lightweight-x2-64/resolve/main/onnx/model.onnx',
    fallbackUrls: ['https://www.modelscope.cn/models/Xenova/swin2SR-lightweight-x2-64/resolve/master/onnx/model.onnx?view=false'],
    scale: 2,
    sizeMB: 8.1,
  },
];

export function findModel(id) {
  return MODELS.find((m) => m.id === id);
}
