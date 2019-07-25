const Apify = require('apify');
const Promise = require('bluebird');

const extractTextForSelectors = async (page, selectors) => {
    const result = {};
    const pageFunction = (selectors) => {
        const result = {};
        Object.keys(selectors).forEach((key) => {
            const selector = selectors[key];
            const elements = $(selector);
            if (elements.length) result[key] = elements.map(function() {return $(this).html()}).toArray().join(' ');
        });
        return result;
    };
    const pageFunctionResults = await page.evaluate(pageFunction, selectors);
    Object.keys(pageFunctionResults).forEach((key) => {
        result[key] = Apify.utils.htmlToText(pageFunctionResults[key]).substring(0, 9500);
    });
    return result;
};

const omitSearchParams = (req) => {
    const urlWithoutParams = req.url.split('?')[0];
    req.url = urlWithoutParams;
    req.uniqueKey = urlWithoutParams;
    return req;
};

const extractHashTitles = async (page, request) => {
    const { url } = request;
    let results = await page.evaluate((url) => {
        const results = [];
        const h1 = $('h1').eq(0);
        const h1html = h1.html();
        const h1TextHtml = h1.next().html();
        results.push({ url, title: h1html, text: h1TextHtml });

        const h2s = $('h2');

        h2s.each(function() {
            const sectionId = $(this).parent().attr('id') || $(this).attr('id');
            results.push({
                url: `${url}#${sectionId}`,
                title: [h1html, $(this).html()].join(' - '),
                text:  $(this).siblings().map(function() {return $(this).html()}).toArray().join(' '),
            });
        });

        return results;
    }, url);

    results = results.map((item) => {
        Object.keys(item).forEach((key) => {
            item[key] = Apify.utils.htmlToText(item[key]).substring(0, 9500);
        });
        return item;
    });

    return results;
};

const setUpCrawler = async (input) => {
    const { startUrls, selectors, additionalPageAttrs,
        omitSearchParamsFromUrl, clickableElements,
        keepUrlFragment, someHashParam, pseudoUrls = [], crawlerName } = input;

    const requestQueue = await Apify.openRequestQueue();
    await Promise.map(startUrls, request => requestQueue.addRequest(request), { concurrency: 3 });

    if (pseudoUrls.length === 0) {
        startUrls.forEach(request => pseudoUrls.push({ purl:`${request.url}[.*]` }));
    }
    const pseudoUrlsUpdated = pseudoUrls.map(request => new Apify.PseudoUrl(request.purl));
    console.log(pseudoUrlsUpdated)
    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        launchPuppeteerOptions: {
            // headless: true,
        },
        handlePageFunction: async ({ request, page }) => {
            console.log(`Processing ${request.url}`);
            await Apify.utils.puppeteer.injectJQuery(page);

            if (someHashParam) {
                const results = await extractHashTitles(page, request);
                for (const result of results) {
                    const isResultValid = !Object.keys(selectors).some(key => !result[key]);
                    if (isResultValid) {
                        await Apify.pushData({
                            crawledBy: crawlerName,
                            ...result,
                            ...additionalPageAttrs,
                            '#debug': Apify.utils.createRequestDebugInfo(request),
                        });
                    }
                }
            } else {
                const results = await extractTextForSelectors(page, selectors);
                const isResultValid = !Object.keys(selectors).some(key => !results[key]);
                if (isResultValid) {
                    await Apify.pushData({
                        url: request.url,
                        crawledBy: crawlerName,
                        ...results,
                        ...additionalPageAttrs,
                        '#debug': Apify.utils.createRequestDebugInfo(request),
                    });
                }
            }

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
