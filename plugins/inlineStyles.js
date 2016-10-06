'use strict';

exports.type = 'full';

exports.active = true;

exports.params = {
    juice: {},
    onlyOnceMatching: true
};

exports.description = 'moves styles from <style> to element styles';


var csso    = require('csso'),
    cheerio = require('cheerio'),
    juice   = require('juice'),
    JSAPI   = require('../lib/svgo/jsAPI.js');


function monkeysSvgo(item, callFn, arg) {
  item.content.forEach(function(childItem) {
    if(callFn(item, childItem, arg) && !childItem.isEmpty()) { // recurse
      monkeysSvgo(childItem, callFn, arg);
    }
  });
}

function isSvgoElem(elem) {
  return typeof elem !== 'undefined';
}

function cheerioLoadXml(xml) {
  return cheerio.load(xml, { xmlMode: true });
}
function getXmlTag(elem) {
  return '<' + elem + '>';
}
function makeCheerioElem(elem) {
  return cheerioLoadXml(getXmlTag(elem));
}
function makeCheerioInst(elem) {
  return makeCheerioElem(elem)(elem);
}

function parsePrefixable(fullName) {
  var a = fullName.split(':');
  if(a.length == 1) {
    return { name: a[0] };
  }
  return { prefix: a[0], name: a[1] };
}

function processSvgoElem(pae, ae, $) {
  // note: <xml> element skipped by svgo parser

  if(pae.elem == '#document') {
    pae.$ = $; // attach top cheerio ast node to top svgo ast node
  }

  var textToElem = pae;
  if(isSvgoElem(ae.elem)) {
    var nameInfo = parsePrefixable(ae.elem);

    ae.$ = makeCheerioInst(nameInfo.name);
    pae.$.append(ae.$);

    if(ae.attrs && Object.keys(ae.attrs).length > 0) {
      for(var attrKey in ae.attrs) {
        var attr = ae.attrs[attrKey];

        var attrNamePrefixed = '';
        if(attr.prefix) {
          attrNamePrefixed = attr.prefix + ':';
        }
        attrNamePrefixed = attrNamePrefixed + attr.name;

        ae.$.attr(attrNamePrefixed, attr.value);
      }
    }

    if(nameInfo.prefix) {
      ae.$.prefix = nameInfo.prefix;
    }

    textToElem = ae;
  }

  if(typeof ae.text !== 'undefined') {
    textToElem.$.text(ae.text);
  }

  return true;
}

function createEmptyCheerioDoc() {
  var document  = makeCheerioElem('dummy');
  var $document = document.root().empty();
  return $document;
}

function svgoAst2CheerioAst(data) {
  var $document = createEmptyCheerioDoc();
  monkeysSvgo(data, processSvgoElem, $document);
  return $document;
}


function monkeysCheerio($item, callFn, arg) {
  if(typeof $item.children === 'object') {
    for(var childItemIndex in $item.children) {
      var $childItem = $item.children[ childItemIndex ];
      if(callFn($item, $childItem, arg) && $item.children.length > 0) { // recurse
        monkeysCheerio($childItem, callFn, arg);
      }
    } 
  } else if(typeof $item.children === 'function') {
    $item.children().each(function(childItemIndex, $childItem) {
      if(callFn($item, $childItem, arg) && $item.children.length > 0) { // "
        monkeysCheerio($childItem, callFn, arg);
      }
    });
  } else {
    return;
  }
}

function isCheerioElem($elem) {
  return typeof $elem !== 'undefined';
}
function isCheerioText($elem) {
  return $elem.type == 'text';
}

function makeSvgoElem(elem, parentElem) {
  return new JSAPI({ elem: elem }, parentElem);
}
function makeSvgoText(text, parentElem) {
  return new JSAPI({ text: text }, parentElem);
}

function processCheerioElem($pae, $ae, s) {

  if($pae.name == 'root') {
    $pae.s = s; // attach top svgo ast node to top cheerio ast node
  }

  var $textToElem = $pae;
  if(isCheerioElem($ae) && !isCheerioText($ae)) {
    $ae.s = makeSvgoElem($ae.name, $pae.s);

    $pae.s.content = $pae.s.content || [];
    $pae.s.content.push($ae.s);


    if($ae.attribs && Object.keys($ae.attribs).length > 0) {
      for(var attrName in $ae.attribs) {
        var attrValue    = $ae.attribs[attrName];
        var attrNameInfo = parsePrefixable(attrName);
        $ae.s.addAttr({
          name:   attrNameInfo.name,
          prefix: attrNameInfo.prefix || '', // explicit empty string otherwise expected
          local:  attrNameInfo.name,
          value:  attrValue
        });
      }
    }

    $textToElem = $ae;
  }


  if(isCheerioText($ae)) {
    $pae.s.content = $pae.s.content || [];

    $textToElem.s.content.push( makeSvgoText($ae.data, $pae.s) );
  }

  return true;
}

function cheerioAst2SvgoAst($) {
  var data = makeSvgoElem('#document');
  var $document = $.root()[0];
  monkeysCheerio($document, processCheerioElem, data);
  return data;
}


function cleanupSingleMatches($) {
  // as last step, remove classes when they are used only by one element in document
  var $styles = $('style');
  $styles.each(function(si, $style) {
    if($style.children.length == 0) {
      return;
    }

    var cssStr = $style.children[0].data,
        cssAst = csso.parse(cssStr, {
          context: 'stylesheet'
        });

    var anythingRemoved = false;
    csso.walk(cssAst, function(node, item, list) {
        if(node.type === 'SimpleSelector') {
          var selectorStr = csso.translate(node);

          var $matches = $i(selectorStr);
          if($matches.length == 1) { // if selector matches only once, remove the selector
            list.remove(item);
            anythingRemoved = true;
          }
        }

        // clean up rulesets without any selectors left
        if(node.type === 'Ruleset' &&
           node.selector.selectors.head == null) {
            list.remove(item);
        }
    });

    if(!anythingRemoved) {
      return;
    }

    var newCssStr = csso.translate(cssAst);
    if(newCssStr.trim().length > 0) {
      $style.children[0].data = newCssStr;
    } else {
      // clean up style elements with now empty content
      // note: style elements that already got empty content will 
      //       intentionally not be removed by this plugin.
      $styles.remove($style);
    }
  });
};




/**
  * Moves styles from <style> to element styles
  *
  * @author strarsis <strarsis@gmail.com>
  */
exports.fn = function(data, opts) {
  var juiceOpts = opts.juice;

  // svgo ast to cheerio ast
  var $o = svgoAst2CheerioAst(data);
  var $  = cheerioLoadXml($o.html());

  // juice options required for svg
  juiceOpts.xmlMode = true;

  if(opts.onlyOnceMatching) {
    juiceOpts.removeStyleTags = false;
  }

  var $i = juice.juiceDocument($, juiceOpts);

  if(opts.onlyOnceMatching) {
    cleanupSingleMatches($);
  }

  var dataNew = cheerioAst2SvgoAst($i);
  return dataNew;
};
