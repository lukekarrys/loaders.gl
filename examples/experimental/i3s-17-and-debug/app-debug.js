/* global fetch */
import React, {PureComponent} from 'react';
import {render} from 'react-dom';
import {StaticMap} from 'react-map-gl';
import {HuePicker, MaterialPicker} from 'react-color';

import {lumaStats} from '@luma.gl/core';
import DeckGL from '@deck.gl/react';
import {FlyToInterpolator, View, MapView, WebMercatorViewport} from '@deck.gl/core';
import {LineLayer, ScatterplotLayer} from '@deck.gl/layers';

import {load} from '@loaders.gl/core';
import {I3SLoader} from '@loaders.gl/i3s';
import {ImageLoader} from '@loaders.gl/images';
import {StatsWidget} from '@probe.gl/stats-widget';

import {buildMinimapData} from './helpers/build-minimap-data';
import {INITIAL_EXAMPLE_NAME, EXAMPLES} from './examples';
import AttributesPanel from './components/attributes-panel';
import DebugPanel from './components/debug-panel';
import ControlPanel from './components/control-panel';
import SemanticValidator from './components/semantic-validator';

import {
  INITIAL_MAP_STYLE,
  CONTRAST_MAP_STYLES,
  INITIAL_TILE_COLOR_MODE,
  INITIAL_OBB_COLOR_MODE
} from './constants';
import {COLORED_BY, makeRGBObjectFromColor, getRGBValueFromColorObject} from './color-map';
import {getFrustumBounds} from './frustum-utils';
import TileLayer from './tile-layer/tile-layer';
import ObbLayer from './obb-layer';
import ColorMap from './color-map';
import AttributesTooltip from './components/attributes-tooltip';
import {getTileDebugInfo, getShortTileDebugInfo, validateTile} from './tile-debug';
import {parseTilesetUrlFromUrl, parseTilesetUrlParams} from './url-utils';
import TileValidator from './components/tile-validator';
import {
  generateBinaryNormalsDebugData,
  getNormalSourcePosition,
  getNormalTargetPosition
} from './normals-utils';

const TRANSITION_DURAITON = 4000;
const DEFAULT_NORMALS_GAP = 30; // Gap for normals visualisation to avoid mess on the screen.
const NORMALS_COLOR = [255, 0, 0];
const TEXTURE_CHECKER_URL =
  'https://scontent-hel3-1.xx.fbcdn.net/v/t1.6435-9/116019162_10223606159768024_6216501327358967749_n.jpg?_nc_cat=101&ccb=1-3&_nc_sid=730e14&_nc_eui2=AeGeE5GbbgdnY5DyFEFh7_SAfB_WmpVGZ8Z8H9aalUZnxtVAya4cClSGCHz_zTdCpGTOXg-YouAPCzup1QAzUEuf&_nc_ohc=6p6RG-5ClQAAX_gxaQi&_nc_ht=scontent-hel3-1.xx&oh=171d6693915fe1881b4015892d483311&oe=609C9819';

const INITIAL_VIEW_STATE = {
  longitude: -120,
  latitude: 34,
  height: 600,
  width: 800,
  pitch: 45,
  maxPitch: 60,
  bearing: 0,
  minZoom: 2,
  maxZoom: 30,
  zoom: 14.5
};

const INITIAL_DEBUG_OPTIONS_STATE = {
  // Show minimap
  minimap: true,
  // Use separate traversal for the minimap viewport
  minimapViewport: false,
  // Show bounding volumes
  obb: false,
  // Tile coloring mode selector
  tileColorMode: INITIAL_TILE_COLOR_MODE,
  // Bounding volume coloring mode selector
  obbColorMode: INITIAL_OBB_COLOR_MODE,
  // Select tiles with a mouse button
  pickable: false,
  // Load tiles after traversal.
  // Use this to freeze loaded tiles and see on them from different perspective
  loadTiles: true,
  // Show the semantic validation warnings window
  semanticValidator: false,
  // Use "uv-checker" texture to check UV coordinates
  useUvChecker: false,
  // Enable/Disable wireframe mode
  wireframe: false
};
const STATS_WIDGET_STYLE = {
  wordBreak: 'break-word',
  padding: 12,
  zIndex: '10000',
  maxWidth: 300,
  background: '#000',
  color: '#fff',
  alignSelf: 'flex-start'
};

const VIEWS = [
  new MapView({
    id: 'main',
    controller: true
  }),
  new MapView({
    id: 'minimap',

    // Position on top of main map
    x: '80%',
    y: '80%',
    width: '20%',
    height: '20%',

    // Minimap is overlaid on top of an existing view, so need to clear the background
    clear: true,

    controller: {
      maxZoom: 9,
      minZoom: 9,
      dragRotate: false,
      keyboard: false
    }
  })
];

const TILE_COLOR_SELECTOR = 'Tile Color Selector';

export default class App extends PureComponent {
  constructor(props) {
    super(props);
    this._tilesetStatsWidget = null;
    this._colorMap = null;
    this._uvChecker = null;
    this.state = {
      url: null,
      token: null,
      tileset: null,
      frameNumber: 0,
      name: INITIAL_EXAMPLE_NAME,
      viewState: {
        main: INITIAL_VIEW_STATE,
        minimap: {
          latitude: INITIAL_VIEW_STATE.latitude,
          longitude: INITIAL_VIEW_STATE.longitude,
          zoom: 9,
          pitch: 0,
          bearing: 0
        }
      },
      selectedMapStyle: INITIAL_MAP_STYLE,
      debugOptions: INITIAL_DEBUG_OPTIONS_STATE,
      normalsDebugData: [],
      normalsGap: DEFAULT_NORMALS_GAP,
      tileInfo: null,
      selectedTileId: null,
      coloredTilesMap: {},
      warnings: [],
      viewportTraversersMap: {main: 'main'},
      i3sOptions: {uvChecker: null}
    };
    this._onSelectTileset = this._onSelectTileset.bind(this);
    this._setDebugOptions = this._setDebugOptions.bind(this);
    this._layerFilter = this._layerFilter.bind(this);
    this.handleClosePanel = this.handleClosePanel.bind(this);
    this.handleSelectTileColor = this.handleSelectTileColor.bind(this);
    this.handleClearWarnings = this.handleClearWarnings.bind(this);
    this.handleShowNormals = this.handleShowNormals.bind(this);
    this.handleChangeNormalsGap = this.handleChangeNormalsGap.bind(this);
  }

  componentDidMount() {
    this._memWidget = new StatsWidget(lumaStats.get('Memory Usage'), {
      framesPerUpdate: 1,
      formatters: {
        'GPU Memory': 'memory',
        'Buffer Memory': 'memory',
        'Renderbuffer Memory': 'memory',
        'Texture Memory': 'memory'
      },
      container: this._statsWidgetContainer
    });
    this._tilesetStatsWidget = new StatsWidget(null, {
      container: this._statsWidgetContainer
    });

    // Check if a tileset is specified in the query params
    let tileset;
    const tilesetUrl = parseTilesetUrlFromUrl();
    if (tilesetUrl) {
      tileset = {url: tilesetUrl};
    } else {
      tileset = EXAMPLES[INITIAL_EXAMPLE_NAME];
    }
    this._onSelectTileset(tileset);
    load(TEXTURE_CHECKER_URL, ImageLoader).then(image => (this._uvChecker = image));
  }

  _getViewState() {
    const {viewState, debugOptions} = this.state;
    return debugOptions.minimap ? viewState : {main: viewState.main};
  }

  _getViews() {
    const {debugOptions} = this.state;
    return debugOptions.minimap ? VIEWS : [VIEWS[0]];
  }

  async _onSelectTileset(tileset) {
    const params = parseTilesetUrlParams(tileset.url, tileset);
    const {tilesetUrl, token, name, metadataUrl} = params;
    this.setState({tilesetUrl, name, token});
    this.handleClearWarnings();
    const metadata = await fetch(metadataUrl).then(resp => resp.json());
    this.setState({metadata});
  }

  // Updates stats, called every frame
  _updateStatWidgets() {
    this._memWidget.update();
    this._tilesetStatsWidget.update();
  }

  _onTileLoad(tile) {
    this._updateStatWidgets();
    this.validateTile(tile);
    this.setState({frameNumber: this.state.tileset.frameNumber});
  }

  _onTileUnload() {
    this._updateStatWidgets();
  }

  _onTilesetLoad(tileset) {
    const {zoom, cartographicCenter} = tileset;
    const [longitude, latitude] = cartographicCenter;

    this.setState({
      tileset,
      viewState: {
        main: {
          ...this.state.viewState.main,
          zoom: zoom + 2.5,
          longitude,
          latitude,
          transitionDuration: TRANSITION_DURAITON,
          transitionInterpolator: new FlyToInterpolator()
        },
        minimap: {
          ...this.state.viewState.minimap,
          longitude,
          latitude
        }
      }
    });

    this._tilesetStatsWidget.setStats(tileset.stats);
  }

  _onViewStateChange({viewState, viewId}) {
    const oldViewState = this.state.viewState;
    if (viewId === 'minimap') {
      this.setState({
        viewState: {
          main: {
            ...oldViewState.main,
            longitude: viewState.longitude,
            latitude: viewState.latitude
          },
          minimap: viewState
        }
      });
    } else {
      this.setState({
        viewState: {
          main: viewState,
          minimap: {
            ...oldViewState.minimap,
            longitude: viewState.longitude,
            latitude: viewState.latitude
          }
        }
      });
    }
  }

  _onSelectMapStyle({selectedMapStyle}) {
    this.setState({selectedMapStyle});
  }

  _setDebugOptions(debugOptions) {
    if (debugOptions.tileColorMode !== COLORED_BY.CUSTOM) {
      this.setState({coloredTilesMap: {}, selectedTileId: null});
    }
    this.setState({debugOptions});
  }

  validateTile(tile) {
    const {warnings} = this.state;
    const newWarnings = validateTile(tile);

    if (newWarnings.length) {
      this.setState({
        warnings: [...warnings, ...newWarnings]
      });
    }
  }

  _renderMainOnMinimap() {
    const {
      tileset,
      debugOptions: {minimapViewport}
    } = this.state;
    if (!minimapViewport) {
      return null;
    }
    let data = [];
    if (tileset) {
      data = buildMinimapData(tileset.tiles);
    }
    return new ScatterplotLayer({
      id: 'main-on-minimap',
      data,
      pickable: false,
      opacity: 0.8,
      stroked: true,
      filled: true,
      radiusScale: 1,
      radiusMinPixels: 1,
      radiusMaxPixels: 100,
      lineWidthMinPixels: 1,
      getPosition: d => d.coordinates,
      getRadius: d => d.radius,
      getFillColor: d => [255, 140, 0, 100],
      getLineColor: d => [0, 0, 0, 120]
    });
  }

  _renderLayers() {
    const {
      tilesetUrl,
      token,
      viewState,
      debugOptions: {
        obb,
        tileColorMode,
        obbColorMode,
        pickable,
        minimapViewport,
        loadTiles,
        useUvChecker,
        wireframe
      },
      selectedTileId,
      coloredTilesMap,
      viewportTraversersMap,
      tileset,
      normalsDebugData,
      normalsGap,
      i3sOptions
    } = this.state;
    viewportTraversersMap.minimap = minimapViewport ? 'minimap' : 'main';
    i3sOptions.uvChecker = useUvChecker ? this._uvChecker : null;
    const loadOptions = {
      throttleRequests: true,
      viewportTraversersMap,
      i3s: i3sOptions
    };

    if (token) {
      loadOptions.token = token;
    }

    this._colorsMap = this._colorsMap || new ColorMap();
    const tiles = (tileset || {}).tiles || [];
    const viewport = new WebMercatorViewport(viewState.main);
    const frustumBounds = getFrustumBounds(viewport);

    return [
      new TileLayer({
        id: `i3s-${useUvChecker ? 'uv-checker' : ''}`,
        data: tilesetUrl,
        loader: I3SLoader,
        onTilesetLoad: this._onTilesetLoad.bind(this),
        onTileLoad: this._onTileLoad.bind(this),
        onTileUnload: this._onTileUnload.bind(this),
        colorsMap: this._colorsMap,
        tileColorMode,
        loadOptions,
        pickable,
        loadTiles,
        autoHighlight: true,
        isDebugMode: true,
        selectedTileId,
        coloredTilesMap,
        wireframe
      }),
      new LineLayer({
        id: 'frustum',
        data: frustumBounds,
        getSourcePosition: d => d.source,
        getTargetPosition: d => d.target,
        getColor: d => d.color,
        getWidth: 2
      }),
      new ObbLayer({
        id: 'obb-layer',
        visible: obb,
        tiles,
        coloredBy: obbColorMode,
        colorsMap: this._colorsMap
      }),
      new LineLayer({
        id: 'normals-debug',
        data: normalsDebugData,
        getSourcePosition: (_, {index, data}) => getNormalSourcePosition(index, data, normalsGap),
        getTargetPosition: (_, {index, data}) => getNormalTargetPosition(index, data, normalsGap),
        getColor: () => NORMALS_COLOR,
        getWidth: 1
      }),
      this._renderMainOnMinimap()
    ];
  }

  _renderDebugPanel() {
    const {warnings, debugOptions} = this.state;
    const isClearButtonDisabled = !warnings.length || !debugOptions.semanticValidator;

    return (
      <DebugPanel
        onOptionsChange={this._setDebugOptions}
        clearWarnings={this.handleClearWarnings}
        isClearButtonDisabled={isClearButtonDisabled}
      >
        {this._renderStats()}
      </DebugPanel>
    );
  }

  _renderStats() {
    // TODO - too verbose, get more default styling from stats widget?
    return <div style={STATS_WIDGET_STYLE} ref={_ => (this._statsWidgetContainer = _)} />;
  }

  _renderControlPanel() {
    const {name, tileset, token, metadata, selectedMapStyle} = this.state;
    return (
      <ControlPanel
        tileset={tileset}
        name={name}
        metadata={metadata}
        token={token}
        onExampleChange={this._onSelectTileset}
        onMapStyleChange={this._onSelectMapStyle.bind(this)}
        selectedMapStyle={selectedMapStyle}
      />
    );
  }

  _layerFilter({layer, viewport}) {
    const {
      debugOptions: {minimapViewport}
    } = this.state;
    const {id: viewportId} = viewport;
    const {
      id: layerId,
      props: {viewportIds = null}
    } = layer;
    if (viewportId !== 'minimap' && (layerId === 'frustum' || layerId === 'main-on-minimap')) {
      // only display frustum in the minimap
      return false;
    }
    if (minimapViewport && viewportId === 'minimap' && layerId.indexOf('obb-debug-') !== -1) {
      return false;
    }
    if (viewportIds && !viewportIds.includes(viewportId)) {
      return false;
    }
    return true;
  }

  getTooltip(info) {
    if (!info.object || info.index < 0 || !info.layer) {
      return null;
    }
    const tileInfo = getShortTileDebugInfo(info.object);
    // eslint-disable-next-line no-undef
    const tooltip = document.createElement('div');
    render(<AttributesTooltip data={tileInfo} />, tooltip);

    return {html: tooltip.innerHTML};
  }

  handleClick(info) {
    if (!info.object) {
      this.handleClosePanel();
      return;
    }
    // TODO add more tile info to panel.
    const tileInfo = getTileDebugInfo(info.object);
    this.setState({tileInfo, selectedTileId: info.object.id, normalsDebugData: []});
  }

  handleClosePanel() {
    this.setState({tileInfo: null, selectedTileId: null, normalsDebugData: []});
  }

  handleSelectTileColor(tileId, selectedColor) {
    const {coloredTilesMap} = this.state;
    const color = getRGBValueFromColorObject(selectedColor);
    const updatedMap = {
      ...coloredTilesMap,
      ...{[tileId]: color}
    };
    this.setState({coloredTilesMap: updatedMap});
  }

  handleResetColor(tileId) {
    const {coloredTilesMap} = this.state;
    const updatedColoredMap = {...coloredTilesMap};
    delete updatedColoredMap[tileId];

    this.setState({coloredTilesMap: updatedColoredMap});
  }

  getResetButtonStyle(isResetButtonDisabled) {
    return {
      display: 'flex',
      padding: '6px 12px',
      color: 'white',
      background: isResetButtonDisabled ? 'gray' : 'red',
      alignItems: 'center',
      height: '20px',
      marginTop: '10px',
      cursor: isResetButtonDisabled ? 'auto' : 'pointer'
    };
  }

  handleClearWarnings() {
    this.setState({warnings: []});
  }

  handleShowNormals(tile) {
    const {normalsDebugData} = this.state;

    this.setState({
      normalsDebugData: !normalsDebugData.length ? generateBinaryNormalsDebugData(tile) : []
    });
  }

  handleChangeNormalsGap(tile, newValue) {
    const {normalsDebugData} = this.state;

    if (normalsDebugData.length) {
      this.setState({normalsDebugData: generateBinaryNormalsDebugData(tile)});
    }

    this.setState({normalsGap: newValue});
  }

  _renderAttributesPanel() {
    const {
      tileInfo,
      debugOptions,
      coloredTilesMap,
      tileset,
      normalsDebugData,
      normalsGap
    } = this.state;
    const isShowColorPicker = debugOptions.tileColorMode === COLORED_BY.CUSTOM;
    const tileId = tileInfo['Tile Id'];
    const tileSelectedColor = makeRGBObjectFromColor(coloredTilesMap[tileId]);
    const isResetButtonDisabled = !coloredTilesMap[tileId];
    const currenTile = tileset._tiles[tileId];

    return (
      <AttributesPanel
        handleClosePanel={this.handleClosePanel}
        attributesObject={tileInfo}
        attributesHeader={'Tile Id'}
        selectTileColor={this.handleSelectTileColor}
      >
        <TileValidator
          tile={currenTile}
          showNormals={Boolean(normalsDebugData.length)}
          normalsGap={normalsGap}
          handleShowNormals={this.handleShowNormals}
          handleChangeNormalsGap={this.handleChangeNormalsGap}
        />
        {isShowColorPicker && (
          <div>
            <h3>{TILE_COLOR_SELECTOR}</h3>
            <HuePicker
              color={tileSelectedColor}
              onChange={color => this.handleSelectTileColor(tileId, color)}
            />
            <MaterialPicker
              color={tileSelectedColor}
              onChange={color => this.handleSelectTileColor(tileId, color)}
            />
            <button
              disabled={isResetButtonDisabled}
              style={this.getResetButtonStyle(isResetButtonDisabled)}
              onClick={() => this.handleResetColor(tileId)}
            >
              Reset
            </button>
          </div>
        )}
      </AttributesPanel>
    );
  }

  _renderSemanticValidator() {
    const {warnings} = this.state;
    return <SemanticValidator warnings={warnings} />;
  }

  render() {
    const layers = this._renderLayers();
    const {selectedMapStyle, tileInfo, debugOptions} = this.state;

    return (
      <div style={{position: 'relative', height: '100%'}}>
        {this._renderDebugPanel()}
        {tileInfo ? this._renderAttributesPanel() : this._renderControlPanel()}
        {debugOptions.semanticValidator && this._renderSemanticValidator()}
        <DeckGL
          layers={layers}
          viewState={this._getViewState()}
          views={this._getViews()}
          layerFilter={this._layerFilter}
          onViewStateChange={this._onViewStateChange.bind(this)}
          onAfterRender={() => this._updateStatWidgets()}
          getTooltip={info => this.getTooltip(info)}
          onClick={info => this.handleClick(info)}
        >
          <StaticMap reuseMaps mapStyle={selectedMapStyle} preventStyleDiffing={true} />
          <View id="minimap">
            <StaticMap
              reuseMaps
              mapStyle={CONTRAST_MAP_STYLES[selectedMapStyle]}
              preventStyleDiffing={true}
            />
          </View>
        </DeckGL>
      </div>
    );
  }
}

export function renderToDOM(container) {
  render(<App />, container);
}