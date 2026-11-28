export const IMAGE_UPLOAD_FORMATS = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
} as const;

export const IMAGE_UPLOAD_ACCEPT = Object.keys(IMAGE_UPLOAD_FORMATS).join(',');
