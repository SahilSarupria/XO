export interface KeyPair {
  readonly publicKey: string; // PEM
  readonly privateKey: string; // PEM
}

export interface Signer {
  generateKeyPair(): KeyPair;
  sign(data: Uint8Array | string, privateKeyPem: string): string; // base64 signature
}

export interface Verifier {
  verify(data: Uint8Array | string, signatureBase64: string, publicKeyPem: string): boolean;
}
