const Apify = require('apify');
const _ = require('underscore');
const algoliasearch = require('algoliasearch');
const Promise = require('bluebird');

const browseAlgoliaIndex = async (index, crawledBy) => {
    const browser = index.browseAll(null, { filters: `crawledBy:${crawledBy}` });
    let pages = [];
    await new Promise((done, failed) => {
        browser.on('result', (content) => {
            console.log('results', content.hits.length);
            // NOTE: In some cases filter param doesn't work ...
            const filteredPage = content.hits.filter(item => item.crawledBy === crawledBy);
            pages = pages.concat(filteredPage);
        });

        browser.on('end', () => {
            console.log('finished');
            done('finished');
        });

        browser.on('error', (err) => {
            failed(err);
        });
    });

    return pages;
};

const pageFunction = (selectors) => {
    const result = {};
    Object.keys(selectors).forEach((key) => {
        const selector = selectors[key];
        const elements = $(selector);
        if (elements.length) result[key] = elements.map(function() {return $(this).html()}).toArray().join(' ');
    });
    return result;
};

const extractTextForSelectors = async (page, selectors) => {
    const result = {};
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

Apify.main(async () => {
    const { algolia, selectors, additionalPageAttrs,
        omitSearchParamsFromUrl, clickableElements,
        keepUrlFragment, someHashParam, pseudoUrls = [], crawlerName } = await Apify.getInput();

    const algoliaApiKey = algolia.apiKey || process.env.ALGOLIA_API_KEY;

    const algoliaClient = algoliasearch(algolia.appId, algoliaApiKey);
    const algoliaSearchIndex = algoliaClient.initIndex(algolia.indexName);

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
            headless: true,
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
                console.log(results);
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
        // maxRequestRetries: 2,
        maxConcurrency: 10,
    });

    await crawler.run();

    const dataset = await Apify.openDataset();
    const datasetInfo = await dataset.getInfo();
    console.log(`Crawler finished, it found ${datasetInfo.cleanItemCount} pages to index!`);
    const pagesInIndex = await browseAlgoliaIndex(algoliaSearchIndex, crawlerName);
    const pagesIndexByUrl = _.indexBy(pagesInIndex, 'url');

    const pagesDiff = {
        pagesToAdd: {},
        pagesToUpdate: {},
        pagesToRemove: pagesIndexByUrl,
    };

    // TODO: Pagination
    const datasetResult = await dataset.getData({ clean: true });
    datasetResult.items.forEach((page) => {
        const { url } = page;
        console.log(url);
        if (pagesIndexByUrl[url]) {
            console.log(`${url} is in the index`);
            pagesDiff.pagesToUpdate[url] = {
                ...page,
                objectID: pagesIndexByUrl[url].objectID,
            };
        } else {
            console.log(`${url} is missing in the index`);
            pagesDiff.pagesToAdd[url] = page;
        }
        delete pagesDiff.pagesToRemove[url];
    });

    await Apify.setValue('OUTPUT', pagesDiff);

    const added = await algoliaSearchIndex.addObjects(Object.values(pagesDiff.pagesToAdd));
    console.log(`Added ${added.objectIDs.length} pages to index`);

    const updated = await algoliaSearchIndex.saveObjects(Object.values(pagesDiff.pagesToUpdate));
    console.log(`Updated ${updated.objectIDs.length} pages to index`);

    const removed = await algoliaSearchIndex.deleteObjects(Object.values(pagesDiff.pagesToRemove).map(item => item.objectID));
    console.log(`Removed ${removed.objectIDs.length} pages to index`);
});
