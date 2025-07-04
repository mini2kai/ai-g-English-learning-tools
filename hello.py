#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Hello World Python Script
我的第一个Python程序

Author: mini2kai
Date: 2025-07-04
Description: 一个简单的Hello World演示程序
"""

def main():
    """主函数"""
    print("="*50)
    print("    欢迎来到我的第一个GitHub仓库！")
    print("="*50)
    
    print("\nHello, World!")
    print("你好，世界！")
    print("🎉 恭喜您成功运行了这个Python程序！")
    
    # 显示一些基本信息
    print("\n" + "="*30)
    print("    项目信息")
    print("="*30)
    print(f"项目名称: demo-project")
    print(f"作者: mini2kai")
    print(f"描述: 我的第一个GitHub仓库")
    print(f"Python版本: 3.x")
    print(f"创建日期: 2025-07-04")
    
    # 简单的交互
    print("\n" + "-"*30)
    print("    用户交互")
    print("-"*30)
    
    try:
        name = input("请输入您的姓名: ")
        if name.strip():
            print(f"\n🎊 很高兴认识您, {name}!")
            print(f"希望您喜欢这个小项目！")
        else:
            print("\n👋 感谢您的访问！")
    except KeyboardInterrupt:
        print("\n\n👋 再见！感谢您的使用！")
    except Exception as e:
        print(f"\n❌ 发生了一个错误: {e}")
    
    print("\n" + "="*50)
    print("    程序结束，感谢使用！")
    print("="*50)

if __name__ == "__main__":
    main()