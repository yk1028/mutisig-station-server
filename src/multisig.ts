import { Coins, LCDClient, LegacyAminoMultisigPublicKey, MsgSend, MultiSignature, SignatureV2, SignDoc, SimplePublicKey, Tx } from '@terra-money/terra.js';
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { GcpHsmKey } from './hsm/GcpHsmKey';
import { GcpHsmSigner } from './hsm/GcpHsmSigner';
import axios from 'axios';

import * as keyInfo from '../.key-info.json';

const terra = new LCDClient({
    URL: 'https://bombay-lcd.terra.dev',
    chainID: 'bombay-12',
    gasPrices: { uluna: 0.01133 },
});

const multisigPubkey = new LegacyAminoMultisigPublicKey(2, [
    new SimplePublicKey(keyInfo.stationServerPublickey),
    new SimplePublicKey(keyInfo.signingServerPublickey),
]);

const requestSignatureToSigningServer = async (receiverAddress: string, amount: Coins.Input, memo: string): Promise<SignatureV2> => {
    const jsonBody = JSON.stringify({ receiverAddress, amount, memo });
    const response = await axios.post(keyInfo.signingServerUrl, { json: jsonBody });
    const simplePublicKey = new SimplePublicKey(keyInfo.signingServerPublickey);
    const descriptor = new SignatureV2.Descriptor(
        new SignatureV2.Descriptor.Single(
            response.data.data.single.mode,
            response.data.data.single.signature
        )
    );

    return new SignatureV2(simplePublicKey, descriptor, response.data.sequence);
}

const requestSignatureToStationServer = async (tx: Tx): Promise<SignatureV2> => {

    const multiSigAddress = multisigPubkey.address();
    const accInfo = await terra.auth.accountInfo(multiSigAddress);
    const gcpHsmKey = await getGcpHsmKey();

    return await gcpHsmKey.createSignatureAmino(
        new SignDoc(
            terra.config.chainID,
            accInfo.getAccountNumber(),
            accInfo.getSequenceNumber(),
            tx.auth_info,
            tx.body
        )
    );
}

const getGcpHsmKey = async (): Promise<GcpHsmKey> => {
    const kms = new KeyManagementServiceClient();
    const versionName = kms.cryptoKeyVersionPath(
        keyInfo.gcpInfo.projectId,
        keyInfo.gcpInfo.locationId,
        keyInfo.gcpInfo.keyRingId,
        keyInfo.gcpInfo.keyId,
        keyInfo.gcpInfo.versionId
    );
    const gcpHsmSigner = new GcpHsmSigner(kms, versionName);
    const pubkey = await gcpHsmSigner.getPublicKey();
    return new GcpHsmKey(gcpHsmSigner, pubkey);
}

const createTx = async (receiverAddress: string, amount: Coins.Input, memo: string): Promise<Tx> => {

    const address = multisigPubkey.address();
    const accInfo = await terra.auth.accountInfo(address);

    const msg = new MsgSend(
        address,
        receiverAddress,
        amount
    );

    return await terra.tx.create(
        [
            {
                address,
                sequenceNumber: accInfo.getSequenceNumber(),
                publicKey: accInfo.getPublicKey(),
            },
        ],
        {
            msgs: [msg],
            memo: memo
        }
    );
}

const multisig = async () => {

    const receiverAddress = 'terra1756rgnf42t73zjzdreg9xshvq7csq3pvsfkyl3';
    const amount = { uluna: 1 };
    const memo = "memo"

    const multisigAddress = multisigPubkey.address();
    const multisigAccInfo = await terra.auth.accountInfo(multisigAddress);

    const tx = await createTx(receiverAddress, amount, memo)

    const multisig = new MultiSignature(multisigPubkey);
    const signingServerSig = await requestSignatureToSigningServer(receiverAddress, amount, memo);
    const stationServerSig = await requestSignatureToStationServer(tx); // current server

    multisig.appendSignatureV2s([signingServerSig, stationServerSig]);

    tx.appendSignatures([
        new SignatureV2(
            multisigPubkey,
            multisig.toSignatureDescriptor(),
            multisigAccInfo.getSequenceNumber()
        ),
    ])

    console.log(JSON.stringify(tx.toData()));
    terra.tx.broadcastSync(tx).then(console.log);
}

multisig();