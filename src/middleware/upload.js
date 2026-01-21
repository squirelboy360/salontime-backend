const multer = require('multer');
const config = require('../config');

// Configure multer to store files in memory (we'll upload to Supabase)
const storage = multer.memoryStorage();

// Normalize MIME types (some systems use image/jpg instead of image/jpeg)
const normalizeMimeType = (mimeType) => {
  if (mimeType === 'image/jpg') {
    return 'image/jpeg';
  }
  return mimeType;
};

// File filter for avatar uploads
const fileFilter = (req, file, cb) => {
  const normalizedMimeType = normalizeMimeType(file.mimetype);
  
  // Check if normalized type is allowed or original is allowed
  if (config.upload.allowed_avatar_types.includes(normalizedMimeType) || 
      config.upload.allowed_avatar_types.includes(file.mimetype)) {
    // Normalize the mimetype for downstream processing
    file.mimetype = normalizedMimeType;
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type: ${file.mimetype}. Allowed types: ${config.upload.allowed_avatar_types.join(', ')}`), false);
  }
};

// Multer configuration for avatar uploads
const avatarUpload = multer({
  storage: storage,
  limits: {
    fileSize: config.upload.max_avatar_size
  },
  fileFilter: fileFilter
});

// File filter for salon image uploads (same as avatar)
const salonImageUpload = multer({
  storage: storage,
  limits: {
    fileSize: config.upload.max_avatar_size // Use same size limit
  },
  fileFilter: fileFilter
});

module.exports = {
  avatarUpload: avatarUpload.single('avatar'),
  salonImageUpload: salonImageUpload.single('image'), // For single image
  salonImagesUpload: salonImageUpload.array('images', 10) // For multiple images (max 10)
};

