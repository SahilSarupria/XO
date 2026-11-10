# Independently encrypted fixtures

Written by qpdf (not by this repo's own encryption writer), so decryption is checked against a second implementation.
Source: the `control-text-3p` taxonomy case. Regenerate with:

    qpdf --encrypt "" owner 128 --use-aes=y -- src.pdf q-owner-aes-128.pdf
    qpdf --encrypt "" owner 256 -- src.pdf q-owner-aes-256-r6.pdf
    qpdf --encrypt "" owner 256 --force-R5 -- src.pdf q-owner-aes-256-r5.pdf
    qpdf --encrypt userpw owner 256 -- src.pdf q-user-aes-256-r6.pdf

Current qpdf refuses to write RC4; RC4 is covered by the taxonomy writer (`test/taxonomy/pdf-encrypt.ts`).
