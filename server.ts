import { ApiPromise, Keyring, WsProvider } from '@polkadot/api';
import parser from 'body-parser';
import cors from 'cors';
import express from 'express';
import * as $ from "parity-scale-codec";
import { keccak256AsU8a } from '@polkadot/util-crypto';
import { hexToU8a, stringToU8a, u8aToHex } from '@polkadot/util';
import axios from 'axios';
import config from './config.json';

(async () => {
  const provider = new WsProvider(config.endpoint);
  const chain = await ApiPromise.create({ provider });
  const keyring = new Keyring({ type: 'sr25519' });
  const keypair = keyring.addFromUri(config.advertiserMnemonic);

  const app = express();
  const port = 3002;

  app.use(cors());

  app.use(parser.urlencoded({ extended: false }));
  app.use(parser.json());

  app.get('/api', async (_, res) => {
    res.status(200).send('Hello Parami').end();
  });

  app.post('/api/submitScore', async (req, res) => {
    let { ad, nftId, did, referrer, score, tag } = req.body;

    score = Math.max(Math.min(5, score), -5) || 0;

    let currentScores;
    try {
      const resp = await axios.get(`${config.airdropServer}/advertisers/scores?ad=${ad}&nft=${nftId}&did=${did}`);
      currentScores = resp.data.scores;
    } catch (e) {
      currentScores = [];
    }

    const tag2Score: { [tag: string]: number } = {};
    currentScores.forEach((score: any) => {
      if (score.tag && score.tag !== 'null') {
        tag2Score[score.tag] = parseInt(score.score, 10);
      }
    });
    if (tag) {
      tag2Score[tag] = parseInt(score, 10);
    }

    const scores = Object.keys(tag2Score).map(tag => {
      return {
        tag,
        score: tag2Score[tag]
      }
    });

    const adIdU8a = hexToU8a(ad);
    const nftIdU8a = $.u32.encode(parseInt(nftId, 10));
    const didU8a = hexToU8a(did);

    const scoresU8a = scores.reduce((pre, current) => {
      return new Uint8Array([...pre, ...stringToU8a(current.tag), ...$.i8.encode(current.score)])
    }, new Uint8Array());

    let messageU8a = new Uint8Array([...adIdU8a, ...nftIdU8a, ...didU8a, ...scoresU8a]);

    if (referrer) {
      messageU8a = new Uint8Array([...messageU8a, ...hexToU8a(referrer)]);
    }

    const messageU8aHash = keccak256AsU8a(messageU8a);
    const signature = keypair.sign(messageU8aHash);

    const signatureHex = u8aToHex(signature);


    const reqBody: any = {
      ad, nft: nftId, did, scores, signer_did: config.advertiserDid, signature: signatureHex
    }
    
    if (referrer) {
      reqBody.referer = referrer;
    }
    
    // send all data and sig to node-score
    try {
      const resp = await axios.post(`${config.airdropServer}/advertisers/scores`, reqBody);

      res.status(resp.status).send(resp.data).end();
    } catch (e: any) {
      console.log(e?.data ?? e);
      res.status(e?.response?.status ?? 400).send(e?.data ?? e).end();
    }

  });

  app.listen(port, () => {
    console.log(`server started at http://localhost:${port}`);
  });
})();
