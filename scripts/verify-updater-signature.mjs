import { createHash, createPublicKey, verify } from 'node:crypto';

// Tauri wraps a minisign signature in base64. Verify both the file signature
// and the signed trusted comment, using the key already embedded in the app.
export function verifyUpdaterSignature(bytes, encodedSignature, encodedPublicKey) {
  const keyLines = Buffer.from(encodedPublicKey.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  const signatureLines = Buffer.from(encodedSignature.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  const key = Buffer.from(keyLines[1] || '', 'base64');
  const signature = Buffer.from(signatureLines[1] || '', 'base64');
  const globalSignature = Buffer.from(signatureLines[3] || '', 'base64');
  if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed' || signature.length !== 74 || globalSignature.length !== 64 || !signatureLines[2]?.startsWith('trusted comment: ')) {
    throw new Error('Invalid updater signature encoding');
  }
  if (!key.subarray(2, 10).equals(signature.subarray(2, 10))) throw new Error('Updater signing key does not match the app public key');
  const algorithm = signature.subarray(0, 2).toString();
  if (!['Ed', 'ED'].includes(algorithm)) throw new Error('Unsupported updater signature algorithm');
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]),
    format: 'der', type: 'spki'
  });
  const message = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
  const fileSignature = signature.subarray(10);
  if (!verify(null, message, publicKey, fileSignature)) throw new Error('Updater file signature verification failed');
  const comment = Buffer.from(signatureLines[2].slice('trusted comment: '.length));
  if (!verify(null, Buffer.concat([fileSignature, comment]), publicKey, globalSignature)) throw new Error('Updater trusted comment verification failed');
}
