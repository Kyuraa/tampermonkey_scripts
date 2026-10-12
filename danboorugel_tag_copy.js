// ==UserScript==
// @name         DanTagCopy
// @namespace    http://tampermonkey.net/
// @version      1.0.2
// @description  Copy Danbooru/Gelbooru tags to clipboard, formatted for AI diffusion prompts
// @author       Kyuraa
// @match        https://*.donmai.us/*
// @match        https://gelbooru.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ── Settings ─────────────────────────────────────────────────────────
    const DEFAULTS = {
        targetKind: 'diffusion',    // 'diffusion' | 'novelai'
        escapeBrackets: true,       // escape () and [] in tags
        withUrl: false,             // prepend page URL to prompt
        sortKind: 'scene_sort',     // 'scene_sort' | 'character_sort' | 'no_sort'
    };

    const getSetting = (key) => GM_getValue(key, DEFAULTS[key]);
    const setSetting = (key, val) => GM_setValue(key, val);

    // ── DanbooruTagClassifier ─────────────────────────────────────────────
    class DanbooruTagClassifier {
        static get STAGES() {
            return [
                {
                    group: 'basic', lines: [
                        {
                            name: 'count', keywords: [
                                '1girl', '2girls', '3girls', '4girls', '5girls',
                                '1boy', '2boys', '3boys',
                                'multiple girls', 'multiple boys', 'solo', 'duo', 'group',
                            ]
                        },
                    ]
                },
                {
                    group: 'theme', lines: [
                        {
                            name: 'role', keywords: [
                                'maid', 'butler', 'nurse', 'waitress', 'idol', 'miko', 'shrine maiden',
                                'samurai', 'ninja', 'knight', 'witch', 'magical girl', 'soldier',
                                'police', 'teacher', 'princess', 'queen', 'king', 'office lady',
                            ]
                        },
                        {
                            name: 'costume_meta', keywords: [
                                'alternate costume', 'cosplay',
                                'age up', 'age down',
                                'chibi', 'deformed',
                            ]
                        },
                        {
                            name: 'work_act', keywords: [
                                'sports', 'swimming', 'bathing', 'cooking', 'cleaning', 'fishing',
                                'gardening', 'shopping', 'driving', 'traveling', 'camping', 'skiing',
                                'dancing', 'singing', 'playing', 'reading', 'writing', 'drawing', 'painting',
                                'hug', 'kiss',
                                'sex', 'penetration', 'ejaculation', 'invitation', 'fellatio',
                                'alternate hair length',
                                'official alternate',
                                'incoming',
                                'hetero',
                            ],
                            words: [
                                'yukadon', 'kabedon', 'mizudon',
                                'come hither', 'under covers',
                                'masturbation',
                                'orgy', 'anal', 'oral', 'vaginal',
                                'handjob', 'blowjob', 'facejob', 'facial',
                                'alternate species', 'alternate breast size',
                                'alternate hairstyle',
                            ],
                        },
                    ]
                },
                {
                    group: 'view', lines: [
                        {
                            name: 'shot_range', keywords: [
                                'full body', 'upper body', 'lower body', 'cowboy shot',
                                'close-up', 'portrait', 'profile', 'out of frame',
                            ],
                            words: [
                                'cropped legs', 'cropped torso', 'cropped arms', 'cropped shoulders', 'cropped head', 'cropped tail',
                            ],
                        },
                        { name: 'subject', word: ['trefoil'] },
                        {
                            name: 'camera', keywords: [
                                'from above', 'from behind', 'from below', 'from side',
                                'dutch angle', 'high up', 'multiple views', 'sideways', 'three-quarter view', 'straight-on', 'upside-down',
                                'pov',
                            ]
                        },
                        {
                            name: 'character_facing',
                            words: ['foreshortening'],
                            patterns: [/^facing /, /^\w+ing viewer$/],
                        },
                        { name: 'focus', patterns: [/^focusing /] },
                        { name: 'detailed', patterns: [/^detailed /] },
                    ]
                },
                {
                    group: 'character', lines: [
                        { name: 'kind', patterns: [/ girl$/] },
                        {
                            name: 'body', keywords: [
                                'usuhoso', 'skinny', 'loli', 'shota', 'lolibaba', 'mesugaki', 'oppai loli', 'petite',
                                'shortstacks', 'pear-shaped figure',
                                'curvy',
                                'thick', 'chubby', 'fat', 'obese', 'belly',
                                'child', 'old', 'mature',
                                'futanari', 'futa on female',
                                'faceless',
                            ],
                        },
                        {
                            name: 'body_features', keywords: [
                                'wide hips', 'hip dips', 'narrow waist', 'plump',
                                'pectoral', 'slim legs',
                                'flat ass', 'huge ass', 'muscular',
                            ],
                        },
                        {
                            name: 'hair', keywords: [
                                'bald', 'sidelock', 'chonmage', 'okappa', 'cornrows',
                                'dreadlocks', 'mullet', 'braid', 'bun', 'side up', 'nihongami', 'mizura',
                                'ponytail', 'twintail', 'afro', 'bang', 'intake', 'ahoge', 'comb over',
                                'mohawk', 'blunt ends',
                                'multicolored hair', 'colored inner hair', 'gradient hair', 'rainbow hair',
                                'split-color hair', 'streaked hair', 'two-tone hair', 'colored tips',
                                'bob', 'cut', 'flattop', 'undercut',
                                'drills',
                            ],
                            words: ['half updo', 'one side up', 'two side up',
                                'tri tails', 'quad tails', 'quin tails',
                                'topknot', 'ringlets', 'sidecut'
                            ],
                            patterns: [/ hair$/, / cut$/],
                        },
                        {
                            name: 'facial_hair', keywords: [
                                'beard', 'goatee', 'mustache', 'stubble',
                            ]
                        },
                        { name: 'ear', patterns: [/ ears?$/] },
                        {
                            name: 'eye', keywords: ['sclera'],
                            words: [
                                'heterochromia',
                                'red eyes',
                                'extra eyes', 'missing eye', 'no eyes', 'one-eyed', 'third eye',
                                'tareme', 'tsurime',
                                'mismatched pupils',
                            ],
                            patterns: [
                                /.+(?<!ed|ing) eyes$/,
                                /.+(?<!ed|ing) pupils$/,
                                /.+-shaped pupils$/,
                            ],
                            exclude: { words: ['empty eyes'] },
                        },
                        { name: 'mouth', patterns: [/fangs?$/] },
                        {
                            name: 'breasts_size', keywords: [
                                'flat chest', 'small breasts', 'medium breasts', 'large breasts',
                                'huge breasts', 'gigantic breasts',
                            ]
                        },
                        {
                            name: 'body_parts', keywords: [
                                'tentacle', 'scales', 'claws', 'spikes', 'fins',
                                'nail',
                            ],
                            patterns: [/ halo$/, / wings?$/, / horns?$/, / tails?$/],
                        },
                        {
                            name: 'skin',
                            keywords: ['mole'],
                            words: ['freckles', 'warts'],
                            patterns: [/ skin$/],
                        },
                    ]
                },
                {
                    group: 'face', lines: [
                        {
                            name: 'expression', keywords: [
                                'smile', 'grin', 'crying', 'wink',
                                'expression', 'gently',
                            ]
                        },
                        {
                            name: 'emotion', keywords: [
                                'angry', 'annoyed', 'clenched teeth', 'glaring', 'scowl',
                                'embarrassed', 'blush', 'blush stickers', 'full-face blush', 'nose blush',
                                'bored', 'confident', 'confused', 'crazy', 'despair', 'determined', 'disappointed',
                                'disdain', 'disgust', 'distress', 'drunk', 'ecstasy', 'envy', 'excited', 'exhausted', 'expressionless',
                                'facepalm', 'flustered', 'frustrated', 'furrowed brow', 'grimace', 'guilt', 'happy', 'kubrick stare', 'lonely',
                                'nervous', 'nosebleed', 'round mouth', 'parted lips', 'pain', 'pout',
                                'puffy cheeks', 'raised eyebrow', 'raised eyebrows', 'raised inner eyebrows', 'rape face', 'rolling eyes', 'sad',
                                'depressed', 'frown', 'gloom (expression)', 'tears', 'scared', 'panicking', 'worried', 'serious', 'shaded face', 'shy',
                                'sigh', 'skeptical', 'sleepy', 'squinting', 'sulking', 'surprised', 'thinking', 'pensive', 'unamused', 'v-shaped eyebrows',
                                'wince', 'struggling',
                                'afterglow', 'ahegao', 'silly', 'aroused', 'fucked silly', 'naughty face',
                                'ohhoai', 'ohogao', 'seductive smile', 'torogao', 'mind break',
                                'doyagao', 'smirk', 'smug', 'troll face',
                                'color drain', 'horrified', 'screaming',
                                'sobbing', 'traumatized', 'turn pale', 'wavy mouth',
                            ],
                            words: ['^^^'],
                        },
                        { name: 'gaze', keywords: ['looking', 'staring', 'awe'] },
                        {
                            name: 'emote', words: [
                                'x mouth', '>:)', '>:(', ':>=', '\\(^o^)/',
                                '<o>_<o>', '<|>_<|>', '> <', '>3<'
                            ],
                            patterns: [/^[:;Xx]\w+$/, /^[^\s]_[^\s]$/],
                        },
                        {
                            name: 'mouth_eyes_act', keywords: [
                                'completely unamused',
                                'mouth', 'lip', 'tongue', 'teeth', 'tusk',
                                'open mouth',
                            ],
                            words: [
                                'empty eyes', 'wide-eyed', 'sanpaku',
                                'jitome',
                                'blinking', 'closed eyes', 'one eye closed',
                                'constricted pupils',
                            ]
                        },
                        {
                            name: 'face_parts_act', keywords: [
                                'droll', 'saliva', 'sweat', 'snot', 'spit', 'vomit',
                                'tear',
                            ]
                        },
                        {
                            name: 'emotion_exterior', keywords: [
                                'squiggle', 'sweatdrop', 'anger vein', 'sparkle', 'tear drop',
                                'spoken', 'spoken heart'
                            ]
                        },
                        { name: 'other', words: ['akanbe'] }
                    ]
                },
                {
                    group: 'pose', lines: [
                        {
                            name: 'body_action', words: [
                                'on back', 'on stomach', 'on side',
                                'on one knees', 'all fours',
                            ]
                        },
                        {
                            name: 'body_action', keywords: [
                                'arched back', 'standing', 'sitting', 'kneeling', 'lying', 'squatting',
                                'running', 'jumping', 'leaning', 'stretching', 'spread legs', 'bent over',
                                'relax', 'tense', 'twist', 'turn', 'bend', 'crouch',
                                'reach', 'grab', 'hold', 'push', 'pull', 'lift', 'drop',
                                'adjusting', 'removing', 'putting on', 'biting', 'licking', 'kissing',
                                'kupaa',
                            ],
                        },
                        { name: 'body_style', patterns: [/ bulge$/] },
                        {
                            name: 'hand_arm', keywords: [
                                'hand on', 'hands on', 'arm', 'holding', 'crossed arms', 'hands clasped', 'hand behind',
                                'fist', 'pointing', 'touching', 'grabbing', 'pushing', 'pulling',
                                'beckoning', 'clapping', 'praying', 'saluting', 'waving',
                                'finger',
                            ],
                            patterns: [/(arm|hand)s? up$/, /(arm|hand)s? down$/],
                        },
                    ]
                },
                {
                    group: 'clothing', lines: [
                        {
                            name: 'headwear', keywords: [
                                'hat', 'cap', 'crown', 'tiara', 'veil', 'headband', 'helmet', 'beret', 'nun',
                                'kanzashi', 'scrunchie', 'wig', 'circlet', 'diadem', 'mini crown', 'saishi',
                                'fedora', 'gat', 'tricorne', 'deerstalker', 'kepi', 'bicorne', 'ajirogasa',
                                'budenovka', 'papakha', 'ushanka', 'bashlik', 'toque blanche', 'beanie',
                                'kippah', 'mian guan', 'mitre', 'mortarboard', 'sajkaca', 'songkok',
                                'aviator cap', 'balaclava', 'bandana', 'bonnet', 'dalachi', 'habit',
                                'head scarf', 'hijab', 'jester cap', 'keffiyeh', 'okosozukin', 'shower cap',
                                'shufa guan', 'visor cap', 'chopsticks', 'comb',
                                'hairband', 'hair bow', 'hairbow', 'hair ornament', 'hairpin', 'hairclip',
                            ]
                        },
                        {
                            name: 'neckwear', keywords: [
                                'neck ribbon', 'bowtie', 'necktie', 'ascot', 'choker', 'necklace', 'scarf', 'pendant',
                                'pet cone', 'feather boa', 'jabot', 'lanyard', 'neckerchief', 'lei', 'charm',
                                'amulet', 'locket', 'magatama', 'pentacle', 'stole', 'collar',
                                'detached collar', 'fur collar', 'high collar', 'open collar', 'popped collar',
                                'sailor collar', 'wing collar',
                            ]
                        },
                        {
                            name: 'outerwear', keywords: [
                                'suit', 'coattails', 'jacket', 'coat', 'cloak', 'cape', 'vest', 'uniform',
                                'sailor', 'serafuku', 'fuku', 'school uniform', 'tactical clothes',
                                'bulletproof vest', 'load bearing equipment', 'load bearing vest',
                                'plate carrier', 'night vision device',
                                'turtleneck', 'sleeveless turtleneck', 'v-neck', 'halterneck', 'halter',
                            ]
                        },
                        {
                            name: 'dress', keywords: [
                                'dress', 'tied dress', 'crinoline', 'dirndl', 'evening gown', 'gown',
                                'negligee', 'nightgown', 'sundress',
                                'cheongsam', 'qipao', 'kimono', 'yukata', 'hakama', 'obi',
                                'hanbok', 'ao dai', 'sari',
                                'sweater', 'pajamas', 'hoodie', 'cardigan', 'blazer', 'blouse', 'shirt', 't-shirt',
                                'bandeau', 'sarashi', 'tube top', 'crop top', 'tank top',
                                'bodysuit', 'gimp suit', 'bondage outfit',
                                'playboy bunny', 'bunny suit', 'bunnysuit',
                                'leotard', 'unitard', 'catsuit', 'bikini', 'armor',
                                'swimsuit',
                            ]
                        },
                        {
                            name: 'upperbody_detail', keywords: [
                                'frill', 'camisole', 'corset',
                                'vertical line', 'center frills', 'front-tie',
                                'cloth', 'apron', 'petticoat',
                                'cropped',
                                'out of sleeve',
                                'collarbone', 'breasts', 'chest', 'nipple', 'nipples', 'underboob', 'navel', 'stomach',
                            ]
                        },
                        { name: 'handwear', keywords: ['glove', 'gauntlet'] },
                        {
                            name: 'underwear', keywords: [
                                'lingerie', 'babydoll', 'bodystocking', 'bra', 'bustier', 'chemise',
                                'fishnets', 'garter belt', 'panties', 'boyshort panties', 'strapless bottom',
                                'teddy', 'thong', 'g-string', 'pearl thong', 'male underwear', 'boxers',
                                'briefs', 'boxer briefs', 'bikini briefs', 'jockstrap', 'ball bra',
                                'penis sheath', 'crotch',
                            ]
                        },
                        {
                            name: 'legwear', keywords: [
                                'pants', 'skirt', 'shorts', 'collared shirt',
                                'thighhighs', 'pantyhose', 'stocking', 'leggings', 'over-kneehigh', 'kneehigh',
                                'socks', 'legwear', 'leg warmer',
                                'garter', 'garter straps', 'thigh strap',
                                'zettai ryouiki', 'fine fabric emphasis',
                            ]
                        },
                        { name: 'footwear', keywords: ['boots', 'shoes', 'footwear', 'sandals', 'heels'] },
                        {
                            name: 'accessory', keywords: [
                                'ribbon', 'bow', 'lace', 'earrings', 'earclip', 'bracelet', 'glasses', 'sunglasses', 'mask',
                                'monocle', 'goggles', 'scouter', 'bag', 'pouch', 'zipper', 'highleg',
                                'cuffs', 'sleeve', 'belt', 'o-ring',
                                'blindfold', 'eyepatch',
                            ]
                        },
                        {
                            name: 'lower_cloth_cutout',
                            keywords: ['venus', 'groin'],
                            words: ['hips', 'ass', 'anus', 'underbutt', 'pussy', 'vagina', 'cameltoe'],
                        },
                        {
                            name: 'cloth_details',
                            words: [
                                'ass visible through thighs',
                                'shrug (clothing)',
                                'tented shirt',
                                'bare shoulders', 'off shoulder', 'off-shoulder',
                            ],
                            keywords: [
                                'midriff',
                                'cropped shirt', 'cropped jacket',
                                'butt crack',
                                'wedgie',
                                'tight', 'see-through',
                                'denim', 'leather', 'fabric',
                                'layered',
                                'skin tight',
                                'latex', 'monoglove', 'crotchless', 'ass cutout',
                                'backless panties', 'backless pants', 'breastless clothes', 'nippleless clothes',
                                'cupless bra', 'revealing clothes', 'reverse outfit',
                                'anal ball wear', 'maebari', 'pasties',
                                'removed', 'around waist', 'on shoulders', 'over shoulder', 'unworn',
                                'strap', 'slip',
                                'strapless',
                            ],
                            patterns: [/^covered /, /^impossible /, /^taut /, /^naked /],
                        },
                        { name: 'nude_or_nudelike', keywords: ['nude', 'bottomless', 'topless', 'bare'] },
                        {
                            name: 'other',
                            words: ['makeup', 'eyeliner', 'eyeshadow', 'mascara', 'tan', 'tanlines', 'tanline peek', 'sun tattoo'],
                        }
                    ]
                },
                {
                    group: 'background', lines: [
                        {
                            name: 'place', keywords: [
                                'indoor', 'outdoor', 'forest', 'city', 'school', 'beach', 'sky',
                                'architecture', 'building', 'background', 'landscape', 'nature', 'street', 'garden', 'temple',
                                'floor', 'table', 'wall', 'window', 'door', 'ceil',
                                'room', 'corridor', 'hallway', 'staircase', 'balcony', 'porch', 'patio', 'roof', 'rooftop',
                                'cave', 'tunnel', 'bridge', 'tower', 'castle', 'palace', 'shrine',
                                'dark', 'bright', 'sunny', 'cloud', 'rain', 'snow', 'fogg',
                                'evening', 'night', 'dawn', 'dusk', 'sunset', 'sunrise',
                                'atmosphere', 'lighting', 'shadow', 'reflection', 'refraction', 'lens flare',
                                'lamp', 'candle', 'fireplace', 'chandelier', 'lantern', 'light',
                            ]
                        },
                    ]
                },
                {
                    group: 'other', lines: [
                        { name: 'misc', patterns: [/.*/] },
                    ]
                },
            ];
        }

        static _escapeRegExp(s) {
            return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        static _wordBoundaryMatch(tag, phrase) {
            const pattern = new RegExp('\\b' + this._escapeRegExp(phrase) + '\\b');
            return pattern.test(tag);
        }

        static _isMatch(tag, rule) {
            const t = tag.trim().toLowerCase();
            if (rule.exclude) {
                if (rule.exclude.words && rule.exclude.words.some((w) => t === w.toLowerCase())) return false;
            }
            if (rule.words && rule.words.some((w) => t === w.toLowerCase())) return true;
            if (rule.keywords) {
                for (const kw of rule.keywords) {
                    const k = kw.toLowerCase();
                    if (this._wordBoundaryMatch(t, k)) return true;
                    if (!k.includes(' ')) {
                        if (this._wordBoundaryMatch(t, k + 's') || this._wordBoundaryMatch(t, k + 'es')) return true;
                    }
                }
            }
            if (rule.patterns) {
                for (const pattern of rule.patterns) {
                    if (pattern.test(t)) return true;
                }
            }
            return false;
        }

        static classifyTags(tags) {
            let remaining = [...tags];
            const result = {};
            for (const stage of this.STAGES) {
                const subgroups = [];
                for (const line of stage.lines) {
                    const matched = [];
                    const rest = [];
                    for (const tag of remaining) {
                        if (this._isMatch(tag, line)) matched.push(tag);
                        else rest.push(tag);
                    }
                    if (matched.length > 0) subgroups.push({ name: line.name, tags: matched });
                    remaining = rest;
                }
                if (subgroups.length > 0) result[stage.group] = subgroups;
            }
            return result;
        }
    }

    // ── PrompterTagSorter ─────────────────────────────────────────────────
    class PrompterTagSorter {
        static get GROUP_ORDER_PRESETS() {
            return {
                scene_sort: ['header', 'basic', 'theme', 'view', 'character', 'face', 'pose', 'clothing', 'background', 'other'],
                character_sort: ['header', 'character', 'clothing', 'face', 'pose', 'basic', 'theme', 'view', 'background', 'other'],
            };
        }

        static sorting(sortKind, isEscapeBrackets, targetKind, classifiedDanbooruTagTree) {
            if (sortKind === 'no_sort') {
                return this._flattenTree(classifiedDanbooruTagTree)
                    .map((tag) => this._convertSeparator(this._escapeTag(tag, isEscapeBrackets), targetKind))
                    .sort()
                    .join(', ');
            }
            const ordered = this._orderGroups(sortKind, classifiedDanbooruTagTree);
            const transformed = ordered.map((g) => ({
                group: g.group,
                lines: g.lines.map((line) =>
                    line.map((tag) => this._convertSeparator(this._escapeTag(tag, isEscapeBrackets), targetKind))
                ),
            }));
            return this._assemble(transformed);
        }

        static _flattenTree(tree) {
            return Object.keys(tree).reduce((acc, group) => {
                tree[group].forEach((subgroup) => acc.push(...subgroup.tags));
                return acc;
            }, []);
        }

        static _orderGroups(sortKind, tree) {
            const preset = this.GROUP_ORDER_PRESETS[sortKind];
            if (!preset) throw new Error('unknown sortKind: ' + sortKind);
            const existingGroups = Object.keys(tree);
            return preset
                .filter((group) => existingGroups.includes(group))
                .map((group) => ({ group, lines: tree[group].map((subgroup) => subgroup.tags) }));
        }

        static _escapeTag(tag, isEscapeBrackets) {
            if (!isEscapeBrackets) return tag;
            return tag.replace(/[()[\]]/g, (c) => '\\' + c);
        }

        static _convertSeparator(tag, targetKind) {
            if (targetKind === 'novelai') return tag.replace(/ /g, '_');
            return tag;
        }

        static _assemble(orderedGroups) {
            return orderedGroups
                .map((g) => g.lines.map((line) => line.join(', ')).join(',\n'))
                .join(',\n\n');
        }
    }

    // ── Tag collection ────────────────────────────────────────────────────
    function collectTagsFronTagType_sidebar(sidebarElement, tagType) {
        const pes = Array.from(sidebarElement.getElementsByClassName(tagType));
        const tags = [];
        for (const pe of pes) {
            if (!pe) continue;
            const es = pe.getElementsByClassName('search-tag');
            for (const element of es) {
                let tag;
                for (let i = 0; i < element.childNodes.length; i++) {
                    if (element.childNodes[i].nodeType === Node.TEXT_NODE) {
                        tag = element.childNodes[i].textContent;
                    }
                }
                if (!tag) {
                    tags.push(element.innerText);
                    break;
                }
                tags.push(tag);
            }
        }
        return tags;
    }

    function collectTagStructFromSidebar(sidebarElement) {
        const tagst = { characters: [], generals: [] };
        tagst.characters = collectTagsFronTagType_sidebar(sidebarElement, 'tag-type-4');
        tagst.generals = collectTagsFronTagType_sidebar(sidebarElement, 'tag-type-0');
        tagst.url = window.location.href;
        return tagst;
    }

    function getTagFromAElement(element) {
        if (!element || typeof element.getAttribute !== 'function') return null;
        const href = element.getAttribute('href');
        if (!href) return null;
        const queryString = href.includes('?') ? href.split('?')[1] : href;
        const params = new URLSearchParams(queryString);
        if (!params.has('tags')) return null;
        return params.get('tags').replace(/_/g, ' ');
    }

    function collectTagsFronTagType_taglist(taglistElement, tagType) {
        const pes = Array.from(taglistElement.getElementsByClassName(tagType));
        const tags = [];
        for (const pe of pes) {
            if (!pe) continue;
            let tag;
            const es = pe.getElementsByTagName('a');
            for (const element of es) {
                tag = getTagFromAElement(element);
                if (tag) break;
            }
            if (!tag) continue;
            tags.push(tag);
        }
        return tags;
    }

    function collectTagStructFromTaglist(taglistElement) {
        const tagst = { characters: [], generals: [] };
        tagst.characters = collectTagsFronTagType_taglist(taglistElement, 'tag-type-character');
        tagst.generals = collectTagsFronTagType_taglist(taglistElement, 'tag-type-general');
        tagst.url = window.location.href;
        return tagst;
    }

    function collectTagStruct() {
        const sidebar = document.getElementById('sidebar');
        if (sidebar) return collectTagStructFromSidebar(sidebar);
        const taglist = document.getElementById('tag-list');
        if (taglist) return collectTagStructFromTaglist(taglist);
        return undefined;
    }

    // ── Clipboard (GM_setClipboard — bypasses all browser/extension hooks) ──
    function copyToClipboardFallback(text) {
        try {
            GM_setClipboard(text, 'text');
            return true;
        } catch (e) {
            return false;
        }
    }

    // ── Core action ───────────────────────────────────────────────────────
    function copyTags(btn) {
        const tagst = collectTagStruct();
        if (!tagst) {
            alert('DanTagCopy: tags not detected on this page.');
            return;
        }

        const targetKind = getSetting('targetKind');
        const escapeBrackets = getSetting('escapeBrackets');
        const withUrl = getSetting('withUrl');
        const sortKind = getSetting('sortKind');

        let classifiedTree = DanbooruTagClassifier.classifyTags(tagst.generals);
        classifiedTree['header'] = [{ name: 'character', tags: tagst.characters }];

        let prompt = PrompterTagSorter.sorting(sortKind, escapeBrackets, targetKind, classifiedTree);

        if (withUrl) {
            prompt = `\n( ${tagst.url} :0.0)\n` + prompt;
        }

        function showCopied() {
            if (btn) {
                const orig = btn.textContent;
                btn.textContent = 'Copied!';
                btn.style.background = '#4caf50';
                setTimeout(() => {
                    btn.textContent = orig;
                    btn.style.background = '';
                }, 1500);
            }
        }

        if (copyToClipboardFallback(prompt)) {
            showCopied();
        } else {
            alert('DanTagCopy: clipboard write failed.');
        }
    }

    // ── Button ────────────────────────────────────────────────────────────
    function addButton() {
        const btn = document.createElement('button');
        btn.textContent = 'Copy Tags';
        btn.title = 'DanTagCopy: copy tags to clipboard';
        Object.assign(btn.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            zIndex: '9999',
            padding: '8px 14px',
            fontSize: '13px',
            fontWeight: 'bold',
            cursor: 'pointer',
            border: '1px solid #888',
            borderRadius: '4px',
            background: '#333',
            color: '#fff',
            transition: 'background 0.2s',
        });
        btn.addEventListener('click', () => copyTags(btn));
        document.body.appendChild(btn);
    }

    // ── Settings menu ─────────────────────────────────────────────────────
    GM_registerMenuCommand('DanTagCopy: targetKind (' + getSetting('targetKind') + ')', () => {
        const val = prompt('targetKind: "diffusion" or "novelai"', getSetting('targetKind'));
        if (val === 'diffusion' || val === 'novelai') setSetting('targetKind', val);
    });

    GM_registerMenuCommand('DanTagCopy: sortKind (' + getSetting('sortKind') + ')', () => {
        const val = prompt('sortKind: "scene_sort", "character_sort", or "no_sort"', getSetting('sortKind'));
        if (['scene_sort', 'character_sort', 'no_sort'].includes(val)) setSetting('sortKind', val);
    });

    GM_registerMenuCommand('DanTagCopy: escapeBrackets (' + getSetting('escapeBrackets') + ')', () => {
        const val = prompt('escapeBrackets: "true" or "false"', String(getSetting('escapeBrackets')));
        if (val === 'true' || val === 'false') setSetting('escapeBrackets', val === 'true');
    });

    GM_registerMenuCommand('DanTagCopy: withUrl (' + getSetting('withUrl') + ')', () => {
        const val = prompt('withUrl: "true" or "false"', String(getSetting('withUrl')));
        if (val === 'true' || val === 'false') setSetting('withUrl', val === 'true');
    });

    // ── Init ──────────────────────────────────────────────────────────────
    addButton();
})();
