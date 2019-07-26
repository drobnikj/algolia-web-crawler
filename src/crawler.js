const Apify = require('apify');
const Promise = require('bluebird');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/**
 * This is default pageFunction. It can be overriden using pageFunction on input.
 * It can return single object or array of object which will be save to index.
 * @param page - Reference to the Puppeteer Page
 * @param request - Apify.Request object
 * @param selectors - Selectors from input.selectors
 * @param Apify - Reference to the Apify SDK
 */
const defaultPageFunction = async ({ page, request, selectors, Apify }) => {
    const result = {
        url: request.url,
        '#debug': Apify.utils.createRequestDebugInfo(request),
    };
    const getSelectorsHTMLContent = (selectors) => {
        const result = {};
        Object.keys(selectors).forEach((key) => {
            const selector = selectors[key];
            const elements = $(selector);
            if (elements.length) result[key] = elements.map(function() {return $(this).html()}).toArray().join(' ');
        });
        return result;
    };
    const selectorsHTML = await page.evaluate(getSelectorsHTMLContent, selectors);
    Object.keys(selectorsHTML).forEach((key) => {
        result[key] = Apify.utils.htmlToText(selectorsHTML[key]).substring(0, 9500);
    });
    return result;
};

const omitSearchParams = (req) => {
    const urlWithoutParams = req.url.split('?')[0];
    req.url = urlWithoutParams;
    req.uniqueKey = urlWithoutParams;
    return req;
};

const setUpCrawler = async (input) => {
    const { startUrls, selectors, additionalPageAttrs,
        omitSearchParamsFromUrl, clickableElements, pageFunction,
        keepUrlFragment, someHashParam, pseudoUrls = [], crawlerName } = input;

    const requestQueue = await Apify.openRequestQueue();
    await Promise.map(startUrls, request => requestQueue.addRequest(request), { concurrency: 3 });

    if (pseudoUrls.length === 0) {
        startUrls.forEach(request => pseudoUrls.push({ purl: `${request.url}[.*]` }));
    }
    const pseudoUrlsUpdated = pseudoUrls.map(request => new Apify.PseudoUrl(request.purl));
    console.log(pseudoUrlsUpdated)

    // NOTE: This is for local runs purposes.
    // You can override pageFunction with file pageFunction in same dir.
    let localPageFunction;
    if (!pageFunction && fs.existsSync(path.join(__dirname, 'page_function.js'))) {
        console.log('Using local pageFunction!');
        localPageFunction = require('./page_function.js');
    }

    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        launchPuppeteerOptions: {
            // headless: true,
        },
        handlePageFunction: async ({ request, page }) => {
            console.log(`Processing ${request.url}`);
            await Apify.utils.puppeteer.injectJQuery(page);

            // Get results from the page
            let results;
            const pageFunctionContext = { page, request, selectors, Apify };
            if (pageFunction) {
                results = await vm.runInThisContext(pageFunction)(pageFunctionContext);
            } else if (localPageFunction) {
                results = await localPageFunction(pageFunctionContext);
            } else {
                results = await defaultPageFunction(pageFunctionContext);
            }

            // Validate results and push to dataset
            const type = typeof results;
            if (type !== 'object') {
                throw new Error(`Page function must return Object or Array, it returned ${type}.`);
            }
            if (!Array.isArray(results)) results = [results];
            const cleanResults = results.filter((result) => {
                const isResultValid = result.url && !Object.keys(selectors).some(key => !result[key]);
                return isResultValid;
            });
            await Apify.pushData(cleanResults);

            // Enqueue following links
            const enqueueLinksOpts = {
                page,
                selector: clickableElements || 'a',
                pseudoUrls: pseudoUrlsUpdated,
                requestQueue,
            };
            if (omitSearchParamsFromUrl) enqueueLinksOpts.transformRequestFunction = omitSearchParams;
            if (keepUrlFragment) {
                enqueueLinksOpts.transformRequestFunction = (request) => {
                    request.keepUrlFragment = true;
                    return request;
                };
            }
            await Apify.utils.enqueueLinks(enqueueLinksOpts);
        },
        handleFailedRequestFunction: async ({ request }) => {
            console.log(`Request ${request.url} failed too many times`);
            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
            });
        },
    });

    return crawler;
};

module.exports = { setUpCrawler };
