var webpack = require('webpack');
var path = require('path');
const WebpackShellPlugin = require('webpack-shell-plugin');

var config = {
    target: 'node',
    watch: false,
    // externals: [
    //     {
    //         'electron-config': 'electron-config',
    //     },
    // ],
    entry: [
        // 'webpack-hot-middleware/client?reload=true&path=http://localhost:9000/__webpack_hmr',
        './src/index.js',
    ],
    module: {
        rules: [
            {
                test: /\.jsx?$/,
                exclude: /(node_modules)/,
                use: {
                    loader: 'babel-loader',
                    options: {},
                },
            }
        ],
    },
    output: {
        path: __dirname + '/dist',
        publicPath: '/',
        filename: 'bundle.js',
    },
    node: {
        __dirname: false,
        __filename: false,
    },
    mode: 'development',
};
module.exports = config;
