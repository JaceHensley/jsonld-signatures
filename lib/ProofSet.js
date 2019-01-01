/*!
 * Copyright (c) 2018 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

const constants = require('./constants');
const jsonld = require('jsonld');
const {extendContextLoader, strictDocumentLoader} = require('./documentLoader');
const strictExpansionMap = require('./expansionMap');
const PublicKeyProofPurpose = require('./purposes/PublicKeyProofPurpose');

module.exports = class ProofSet {
  /**
   * Adds a Linked Data proof to a document. If the document contains other
   * proofs, the new proof will be appended to the existing set of proofs.
   *
   * Important note: This method assumes that the term `proof` in the given
   * document has the same definition as the `https://w3id.org/security/v2`
   * JSON-LD @context.
   *
   * @param document {object|string} Object to be signed, either a string URL
   *   (resolved via the given `documentLoader`) or a plain object (JSON-LD
   *   document).
   * @param options {object} Options hashmap.
   *
   * A `suite` option is required:
   *
   * @param options.suite {LinkedDataSignature} a signature suite instance
   *   that will create the proof.
   *
   * A `purpose` option is required:
   *
   * @param options.purpose {ProofPurpose} a proof purpose instance that will
   *   augment the proof with information describing its intended purpose.
   *
   * Advanced optional parameters and overrides:
   *
   * @param [documentLoader] {function} a custom document loader,
   *   `Promise<RemoteDocument> documentLoader(url)`.
   * @param [expansionMap] {function} A custom expansion map that is
   *   passed to the JSON-LD processor; by default a function that will throw
   *   an error when unmapped properties are detected in the input, use `false`
   *   to turn this off and allow unmapped properties to be dropped or use a
   *   custom function.
   * @param [compactProof] {boolean} `true` instructs this call to compact
   *   the resulting proof to the same JSON-LD `@context` as the input
   *   document; this is the default behavior. Setting this flag to `false` can
   *   be used as an optimization to prevent an unnecessary compaction when the
   *   caller knows that all used proof terms have the same definition in the
   *   document's `@context` as the `constants.SECURITY_CONTEXT_URL` `@context`.
   *
   * @return {Promise<object>} resolves with the signed document, with
   *   the signature in the top-level `proof` property.
   */
  async add(document, {
    suite, purpose, documentLoader, expansionMap,
    compactProof = true} = {}) {
    if(!suite) {
      throw new TypeError('"options.suite" is required.');
    }
    if(!purpose) {
      throw new TypeError('"options.purpose" is required.');
    }

    if(suite.legacy) {
      if(!(purpose instanceof PublicKeyProofPurpose)) {
        throw new TypeError(
          `The "${suite.type}" suite requires "options.purpose" to be ` +
          'an instance of "PublicKeyProofPurpose".');
      }
    }

    if(documentLoader) {
      documentLoader = extendContextLoader(documentLoader);
    } else {
      documentLoader = strictDocumentLoader;
    }
    if(expansionMap !== false) {
      expansionMap = strictExpansionMap;
    }

    if(typeof document === 'string') {
      // fetch document
      document = await documentLoader(document);
    }

    // preprocess document to prepare to remove existing proofs
    let input;
    let existingProofs;
    const proofProperty = suite.legacy ? 'signature' : 'proof';
    if(compactProof) {
      // cannot assume security context terms, so do full expansion
      ([input = {}] = await jsonld.expand(
        document, {documentLoader, expansionMap}));
      // excluding any existing proof(s)
      if(suite.legacy) {
        delete input[constants.SECURITY_SIGNATURE_URL];
      } else {
        delete input[constants.SECURITY_PROOF_URL];
      }
    } else {
      // modify document in place to maximize optimization
      input = document;
      // save but exclude any existing proof(s)
      existingProofs = input[proofProperty];
      delete document[proofProperty];
    }

    // create the new proof (suites MUST output a proof using the security-v2
    // `@context`)
    const proof = await suite.createProof({
      document: input, purpose, documentLoader,
      expansionMap, compactProof});

    if(compactProof) {
      // compact proof to match document's context
      let expandedProof;
      if(suite.legacy) {
        expandedProof = {
          [constants.SECURITY_SIGNATURE_URL]: proof
        };
      } else {
        expandedProof = {
          [constants.SECURITY_PROOF_URL]: {'@graph': proof}
        };
      }
      const ctx = jsonld.getValues(document, '@context');
      const compactProof = await jsonld.compact(
        expandedProof, ctx,
        {documentLoader, expansionMap, compactToRelative: false});
      delete compactProof['@context'];

      // add proof to document
      const key = Object.keys(compactProof)[0];
      jsonld.addValue(document, key, compactProof[key]);
    } else {
      // in-place restore any existing proofs
      if(existingProofs) {
        document[proofProperty] = existingProofs;
      }
      // add new proof
      delete proof['@context'];
      jsonld.addValue(document, proofProperty, proof);
    }

    return document;
  }

  /**
   * Verify Linked Data proof(s) on a document. The proofs to be verified
   * must match the given proof purpose.
   *
   * Important note: This method assumes that the term `proof` in the given
   * document has the same definition as the `https://w3id.org/security/v2`
   * JSON-LD @context.
   *
   * @param document {object|string} Object with one or more proofs to be
   *   verified, either a string URL (resolved to an object via the given
   *   `documentLoader`) or a plain object (JSON-LD document).
   * @param options {object} Options hashmap.
   *
   * A `suite` option is required:
   *
   * @param options.suite {LinkedDataSignature or Array of LinkedDataSignature}
   *   acceptable signature suite instances for verifying the proof(s).
   *
   * A `purpose` option is required:
   *
   * @param options.purpose {ProofPurpose} a proof purpose instance that will
   *   match proofs to be verified and ensure they were created according to
   *   the appropriate purpose.
   *
   * Advanced optional parameters and overrides:
   *
   * @param [documentLoader] {function} a custom document loader,
   *   `Promise<RemoteDocument> documentLoader(url)`.
   * @param [expansionMap] {function} A custom expansion map that is
   *   passed to the JSON-LD processor; by default a function that will throw
   *   an error when unmapped properties are detected in the input, use `false`
   *   to turn this off and allow unmapped properties to be dropped or use a
   *   custom function.
   * @param [compactProof] {boolean} `true` indicates that this method cannot
   *   assume that the incoming document has defined all proof terms in the
   *   same way as the `constants.SECURITY_CONTEXT_URL` JSON-LD `@context`.
   *   This means that this method must compact any found proofs to this
   *   context for internal and extension processing; this is the default
   *   behavior. To override this behavior and optimize away this step because
   *   the caller knows that the input document's JSON-LD `@context` defines
   *   the proof terms in the same way, set this flag to `false`.
   *
   * @return {Promise<object>} resolves with an object with a `verified`
   *   boolean property that is `true` if at least one proof matching the
   *   given purpose and suite verifies and `false` otherwise; a `results`
   *   property with an array of detailed results; if `false` an `error`
   *   property will be present.
   */
  async verify(document, {
    suite, purpose, documentLoader, expansionMap,
    compactProof = true} = {}) {
    if(!suite) {
      throw new TypeError('"options.suite" is required.');
    }
    if(!purpose) {
      throw new TypeError('"options.purpose" is required.');
    }
    const suites = Array.isArray(suite) ? suite : [suite];
    if(suites.length === 0) {
      throw new TypeError('At least one suite is required.');
    }

    const legacy = suites.some(s => s.legacy);
    if(legacy) {
      if(suites.some(s => !s.legacy)) {
        throw new Error(
          'Legacy suites may not be combined with current suites.');
      } else if(!(purpose instanceof PublicKeyProofPurpose)) {
        throw new TypeError(
          '"options.purpose" must be an instance of "PublicKeyProofPurpose"' +
          'to use a legacy suite.');
      }
    }

    if(documentLoader) {
      documentLoader = extendContextLoader(documentLoader);
    } else {
      documentLoader = strictDocumentLoader;
    }
    if(expansionMap !== false) {
      expansionMap = strictExpansionMap;
    }

    try {
      if(typeof document === 'string') {
        // fetch document
        document = await documentLoader(document);
      } else {
        // TODO: consider in-place editing to optimize when `compactProof`
        // is `false`

        // shallow copy to allow for removal of proof set prior to canonize
        document = {...document};
      }

      // get proofs from document
      const {proofSet, document: doc} = await _getProofs({
        document, legacy, documentLoader, expansionMap, compactProof});
      document = doc;

      // verify proofs
      const results = await _verify({
        document, suites, proofSet,
        purpose, documentLoader, expansionMap, compactProof});
      if(results.length === 0) {
        throw new Error(
          'Could not verify any proofs; no proofs matched the required ' +
          'suite and purpose.');
      }

      // combine results
      const verified = results.some(r => r.verified);
      if(!verified) {
        const errors = [].concat(
          ...results.filter(r => r.error).map(r => r.error));
        const result = {verified, results};
        if(errors.length > 0) {
          result.error = errors;
        }
        return result;
      }
      return {verified, results};
    } catch(error) {
      return {verified: false, error};
    }
  }
};

async function _getProofs({
  document, legacy, documentLoader, expansionMap, compactProof}) {
  // handle document preprocessing to find proofs
  let proofProperty;
  let proofPropertyUrl;
  if(legacy) {
    proofProperty = 'signature';
    proofPropertyUrl = constants.SECURITY_SIGNATURE_URL;
  } else {
    proofProperty = 'proof';
    proofPropertyUrl = constants.SECURITY_PROOF_URL;
  }
  let proofSet;
  if(compactProof) {
    // if we must compact the proof(s) then we must first expand the input
    // document to find the proof(s)
    ([document = {}] = await jsonld.expand(
      document, {documentLoader, expansionMap}));
    proofSet = jsonld.getValues(document, proofPropertyUrl);
    delete document[proofPropertyUrl];
  } else {
    // since proofs needn't be compacted, assume matching term definitions
    proofSet = jsonld.getValues(document, proofProperty);
    delete document[proofProperty];
  }

  if(proofSet.length === 0) {
    // no possible matches
    throw new Error('No matching proofs found in the given document.');
  }

  if(compactProof) {
    // compact proofs to SECURITY_CONTEXT_URL context
    const expanded = {
      [proofPropertyUrl]: proofSet
    };
    const ctx = jsonld.getValues(document, '@context');
    expanded['@context'] = ctx;
    const compact = await jsonld.compact(
      expanded, constants.SECURITY_CONTEXT_URL,
      {documentLoader, expansionMap, compactToRelative: false});
    proofSet = jsonld.getValues(compact, proofProperty).map(proof => {
      proof['@context'] = constants.SECURITY_CONTEXT_URL;
      return proof;
    });
  } else {
    // TODO: consider in-place editing to optimize

    // merely shallow copy proofs and add SECURITY_CONTEXT_URL
    proofSet = proofSet.map(proof => ({
      '@context': constants.SECURITY_CONTEXT_URL,
      ...proof
    }));
  }
  return {proofSet, document};
}

async function _verify({
  document, suites, proofSet, purpose,
  documentLoader, expansionMap, compactProof}) {
  // filter out matching proofs
  const matches = proofSet.filter(proof => purpose ?
    purpose.match(proof, {document, documentLoader, expansionMap}) :
    true);
  if(matches.length === 0) {
    // no matches, nothing to verify
    return [];
  }

  // verify each matching proof
  return (await Promise.all(matches.map(proof => {
    for(const s of suites) {
      if(s.matchProof({proof, document, documentLoader, expansionMap})) {
        return s.verifyProof({
          proof, document, purpose, documentLoader, expansionMap,
          compactProof}).catch(error => ({verified: false, error}));
      }
    }
  }))).map((r, i) => r ? {proof: matches[i], ...r} : null).filter(r => r);
}