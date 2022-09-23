import { ApiPromise, Keyring, WsProvider } from '@polkadot/api';
import parser from 'body-parser';
import cors from 'cors';
import express from 'express';
import * as $ from "parity-scale-codec";
import { keccak256AsU8a } from '@polkadot/util-crypto';
import { hexToU8a, stringToU8a, u8aToHex } from '@polkadot/util';
import axios from 'axios';
import config from './config.json';
import { obtainOauthAccessToken, obtainOauthRequestToken } from './oauth1';
import Client, { auth } from 'twitter-api-sdk';
import Twitter from 'twitter';

(async () => {
  const provider = new WsProvider(config.endpoint);
  const chain = await ApiPromise.create({ provider });
  const keyring = new Keyring({ type: 'sr25519' });
  const keypair = keyring.addFromUri(config.advertiserMnemonic);

  const oauth2Client = new auth.OAuth2User({
    client_id: config.twitter.CLIENT_ID as string,
    client_secret: config.twitter.CLIENT_SECRET as string,
    callback: 'http://localhost:8080/twitter/oauth2/callback',
    scopes: ["tweet.read", "users.read"],
  });

  const app = express();
  const port = 8080;

  app.use(cors());

  app.use(parser.urlencoded({ extended: false }));
  app.use(parser.json());

  app.get('/api', async (_, res) => {
    res.status(200).send('Hello Parami').end();
  });

  app.get('/twitter/oauth1', async (req, res) => {
    const obtainRequestTokenConfig = {
      apiUrl: "https://api.twitter.com/oauth/request_token",
      callbackUrl: 'http://localhost:8080/twitter/oauth1/callback',
      consumerKey: config.twitter.TWITTER_CONSUMER_KEY,
      consumerSecret: config.twitter.TWITTER_CONSUMER_SECRET,
      method: "POST"
    };
    
    const requestTokenData = await obtainOauthRequestToken(
      obtainRequestTokenConfig
    );

    if (requestTokenData.oauth_callback_confirmed !== "true") {
      res.status(503).json({ error: 'Twitter Oauth Request Token Error' }).end();
      return;
    }

    res.redirect(`https://api.twitter.com/oauth/authorize?oauth_token=${requestTokenData.oauth_token}`);
  });

  app.get('/twitter/oauth1/callback', async (req, res) => {
    // Get the oauth_verifier query parameter
    const oauthVerifier = req.query.oauth_verifier as string;
    // Get the oauth_token query parameter. 
    // It's the same as the request token from step 1
    const oauthToken = req.query.oauth_token as string;
    console.log('Got oauth from twitter', oauthVerifier, oauthToken);

    const accessTokenData = await obtainOauthAccessToken({
      apiUrl: "https://api.twitter.com/oauth/access_token",
      consumerKey: config.twitter.TWITTER_CONSUMER_KEY,
      consumerSecret: config.twitter.TWITTER_CONSUMER_SECRET,
      oauthToken,
      oauthVerifier,
      method: "POST"
    });

    // const response = await twitterSignIn.getAccessToken(requestToken, oauthTokenMap[requestToken], oauthVerifier);

    console.log('Got user access token', accessTokenData);

    const { oauth_token, oauth_token_secret } = accessTokenData;

    const client = new Twitter({
      consumer_key: config.twitter.TWITTER_CONSUMER_KEY,
      consumer_secret: config.twitter.TWITTER_CONSUMER_SECRET,
      access_token_key: oauth_token,
      access_token_secret: oauth_token_secret
    });

    client.get('favorites/list', (error: any, tweets: any, response: any) => {
      if (error) throw error;
      console.log(tweets);  // The favorites.
      console.log(response);  // Raw response object.
    });
    
    res.sendStatus(200);
  });

  app.get('/twitter/oauth2', async function (req, res) {
    const { state } = req.query;
    const authUrl = oauth2Client.generateAuthURL({
      state: 'testOauth',
      code_challenge_method: "s256",
    });

    res.redirect(authUrl);
  });

  app.get('/twitter/oauth2/callback', async (req, res) => {
    const { state, code } = req.query;
    await oauth2Client.requestAccessToken(code as string);

    const client = new Client(oauth2Client);

    const myUser: {
      data: {
        id: string;
        name: string;
        username: string;
      }
    } = await client.users.findMyUser() as any;

    console.log('oauth 2 got user', myUser);

    res.sendStatus(200);
  })

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
