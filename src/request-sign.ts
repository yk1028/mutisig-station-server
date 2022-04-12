import { Coins, Key, LCDClient, LegacyAminoMultisigPublicKey, MnemonicKey, MsgSend, MultiSignature, SignatureV2, SignDoc, SimplePublicKey } from '@terra-money/terra.js';
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

const requestSignature = async (receiverAddress: string, amount: Coins.Input, memo: string) => {
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

const request = async () => {

    const receiverAddress = 'terra1756rgnf42t73zjzdreg9xshvq7csq3pvsfkyl3';
    const amount = { uluna: 1 };
    const memo = "memo"

    const multisigPubkey = new LegacyAminoMultisigPublicKey(2, [
        new SimplePublicKey(keyInfo.stationServerPublickey),
        new SimplePublicKey(keyInfo.signingServerPublickey),
    ]);

    const address = multisigPubkey.address();

    const multisig = new MultiSignature(multisigPubkey);

    const msg = new MsgSend(
        address,
        receiverAddress,
        amount
    );

    const accInfo = await terra.auth.accountInfo(address);
    const tx = await terra.tx.create(
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

    const signingServerSig = await requestSignature(receiverAddress, amount, memo);

    // GCP HSM
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
	const gcpHsmKey: Key = new GcpHsmKey(gcpHsmSigner, pubkey);

    const stationServerSig = await gcpHsmKey.createSignatureAmino(
        new SignDoc(
            terra.config.chainID,
            accInfo.getAccountNumber(),
            accInfo.getSequenceNumber(),
            tx.auth_info,
            tx.body
        )
    );

    multisig.appendSignatureV2s([signingServerSig, stationServerSig]);

    tx.appendSignatures([
        new SignatureV2(
            multisigPubkey,
            multisig.toSignatureDescriptor(),
            accInfo.getSequenceNumber()
        ),
    ])

    console.log(JSON.stringify(tx.toData()));
    terra.tx.broadcastSync(tx).then(console.log);
}

request();