export interface KeyPair {
    readonly publicKey: string;
    readonly privateKey: string;
}
export interface Signer {
    generateKeyPair(): KeyPair;
    sign(data: Uint8Array | string, privateKeyPem: string): string;
}
export interface Verifier {
    verify(data: Uint8Array | string, signatureBase64: string, publicKeyPem: string): boolean;
}
//# sourceMappingURL=signer.interface.d.ts.map